import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useBranch } from '../../context/BranchContext';
import { useAuth } from '../../context/AuthContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import FileDetailModal from '../../components/FileDetailModal';
import SyncToMainModal from '../../components/SyncToMainModal';
import { runCommitFlow, buildCommitSnapshot } from '../../lib/commitFlow';
import FileThumbnail from '../../components/FileThumbnail';
import Tooltip from '../../components/Tooltip';
import { describeCloudFile, describeLocalFile } from '../../lib/thumbnailDescriptor';
import {
  listProjectFiles,
  createSignedDownloadUrl,
  subscribeForProject,
  deleteProjectFile,
  evictSignedUrlCache,
} from '../../lib/projectFiles';
import { sha256Hex } from '../../lib/branches';
import { computeSyncState } from '../../lib/syncState';
import {
  localFolderApi,
  hasLocalFolderApi,
  isElectronBranch,
  readLocalBlob,
} from '../../lib/localFolder';
import {
  loadSidecar,
  saveSidecar,
  emptySidecar,
  renameEntry as renameSidecarEntry,
  addEntry as addSidecarEntry,
  removeByFilename as removeSidecarByFilename,
  removeEntry as removeSidecarEntry,
  LEGACY_SIDECAR_KEY,
  toPayload as sidecarToPayload,
} from '../../lib/localBranchMeta';
import './ProjectScoped.css';
import './ProjectFiles.css';

// Per-project memory of the user's chosen download folder. Different
// projects naturally sync to different local locations (one to a
// Documents subfolder, another to a OneDrive path) so the key carries
// the project id.
const LOCAL_FOLDER_KEY = (projectId) => `docvex:project-files-local-folder:${projectId}`;

// Tab persistence lives in BranchContext now — the Main / My branch
// tabs ARE the branch-view selector; clicking a tab calls setView()
// which writes to docvex:branch-view:{projectId}. The old
// cloud-vs-local tab state was removed when those tabs were folded
// into the branch model.

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

// Cloud-with-down-arrow icon — overlay on cards that exist on main
// but not yet in the user's branch folder. Clicking the card fetches
// just that one file so the user can fill in gaps without running a
// full Download (which re-pulls everything).
const CloudDownloadIcon = (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.5 19a5.5 5.5 0 0 0 .5-10.97 7 7 0 1 0-13.4 3.5A4.5 4.5 0 0 0 6.5 19" />
    <polyline points="8 17 12 21 16 17" />
    <line x1="12" y1="12" x2="12" y2="21" />
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
function FileCard({ file, onOpen, branchOverlay }) {
  const [hovered, setHovered] = useState(false);
  // One-line resolution: the descriptor packages the row's
  // thumbnail_path / thumbnail_frames / storage_path / content_hash
  // into a stable cache key + fallback chain. The unified resolver
  // (inside FileThumbnail) handles signing, DOCX rich regen, video
  // frame extraction, and caching across surfaces. Every file in
  // the grid (and every other surface) keys the same way, so two
  // views of the same file paint the same poster.
  const descriptor = useMemo(() => describeCloudFile(file), [
    file.id,
    file.content_hash,
    file.storage_path,
    file.thumbnail_path,
    file.thumbnail_frames,
    file.mime_type,
    file.name,
    file.duration_seconds,
  ]);

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

  // Branch overlay — when a pending branch_changes row targets this
  // file, paint a corner badge calling out the queued kind. Edits
  // shift the displayed name to the proposed value so the card
  // previews how main would look after approval.
  const overlayKind = branchOverlay?.kind || null;
  const overlayName = branchOverlay?.proposed?.name;
  const displayBase = overlayName
    ? (() => {
        let n = overlayName;
        if (nameExt && n.toLowerCase().endsWith(`.${nameExt.toLowerCase()}`)) {
          n = n.slice(0, -(nameExt.length + 1));
        }
        return n;
      })()
    : nameBase;

  const cardClass = [
    'project-files-card',
    overlayKind === 'delete'  && 'is-branch-deleted',
    overlayKind === 'missing' && 'is-branch-missing',
  ].filter(Boolean).join(' ');
  const tooltipText = overlayKind === 'missing'
    ? `${file.name}\nClick to download into your branch`
    : file.name;
  return (
    <Tooltip content={tooltipText}>
      <button
        type="button"
        className={cardClass}
        onClick={() => onOpen?.(file)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
      <div className="project-files-thumb">
        <FileThumbnail descriptor={descriptor} hovered={hovered} />
        {/* Missing-from-branch overlay — a semi-opaque scrim with a
            centered download-cloud icon, only rendered when the
            parent passed branchOverlay.kind === 'missing'. Clicking
            the card downloads just this file (handled at the call
            site via onOpen). */}
        {overlayKind === 'missing' && (
          <span className="project-files-missing-overlay" aria-hidden="true">
            {CloudDownloadIcon}
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
        {overlayKind && (
          <span
            className={`project-files-branch-pill is-${overlayKind}`}
            aria-label={`Queued ${overlayKind}`}
          >
            {overlayKind === 'add'     && 'ADDED'}
            {overlayKind === 'edit'    && 'EDITED'}
            {overlayKind === 'delete'  && 'DELETED'}
            {overlayKind === 'replace' && 'REPLACED'}
          </span>
        )}
        <div className="project-files-meta">
          <div className="project-files-name">{displayBase}</div>
        </div>
      </button>
    </Tooltip>
  );
}

// Module-level cache of locally-extracted thumbnails — blob: URLs
// keyed by `<path>|<mtimeIso>`. Re-mounting the same card (scroll,
// project switch, tab toggle) hits the cache instead of re-running
// the heavy pdf.js / canvas pipeline. Cleared by entry replacement
// when the mtime changes — the OS-side edit produces a new key and
// the old blob URL is revoked at that point.
//
// Cap mirrors FileThumbnail's frame cache: 200 entries before FIFO
// eviction. A typical project has dozens of cards, not thousands;
// 200 covers the working set comfortably.
const LOCAL_THUMB_CACHE = new Map();
const LOCAL_THUMB_CACHE_MAX = 200;

function rememberLocalThumb(key, blobUrl) {
  if (LOCAL_THUMB_CACHE.size >= LOCAL_THUMB_CACHE_MAX) {
    const firstKey = LOCAL_THUMB_CACHE.keys().next().value;
    if (firstKey !== undefined) {
      const old = LOCAL_THUMB_CACHE.get(firstKey);
      try { URL.revokeObjectURL(old); } catch { /* ignore */ }
      LOCAL_THUMB_CACHE.delete(firstKey);
    }
  }
  LOCAL_THUMB_CACHE.set(key, blobUrl);
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
function LocalFileCard({
  file,
  onSelect,            // single-click — just highlights the card (no modal)
  onOpen,              // menu Properties — opens the FileDetailModal (side pane)
  onDoubleOpen,        // double-click — opens the file in its OS default app
  onRename,            // menu Rename — flips the card into inline-rename mode
  onRenameSubmit,      // commits the inline rename (file, newName)
  onRenameCancel,      // dismisses inline rename mode without changes
  onRevert,            // menu Revert — only shown when `modified` AND a cloud counterpart exists
  onDelete,            // menu Delete — see handleDeleteLocalCard in ProjectFiles
  modified,
  bytesChanged,        // true → local bytes diverge from cloud → regenerate thumbnail
                       //         from disk instead of showing the (now stale) cloud thumb
  selected,            // true → card paints the accent highlight ring
  isRenaming,          // true → name slot becomes an <input> with the basename selected
  cloud,
  overlay,
  localContentHash,    // SHA-256 of the on-disk bytes (from parent's localHashByName)
                       // — feeds into the descriptor's contentKey so an in-place
                       // edit invalidates every cache layer at once.
}) {
  const [hovered, setHovered] = useState(false);
  const { base: diskBase, ext } = splitNameAndExtension(file.name);
  // Effective display name precedence:
  //   1. overlay.proposed.name  — un-pushed metadata edit. Briefly
  //      authoritative between "user typed a new name in the modal"
  //      and "auto-commit pushes it"; after the push the overlay
  //      is consumed and we fall through.
  //   2. diskBase               — the on-disk basename, which IS
  //      the truth for a local card. After an inline rename the
  //      disk has the new name immediately; falling back to
  //      cloud.name here would show the OLD canonical name (the
  //      cloud row doesn't update until admin approval) and leave
  //      the user staring at "caca.png" on a file that's actually
  //      called "newname.png" on disk.
  //   3. cloud.name             — last-resort safety net for the
  //      bootstrap window where diskBase is somehow blank.
  const proposedName = overlay?.proposed?.name;
  const sourceName = proposedName || diskBase || cloud?.name || null;
  let base = diskBase;
  if (sourceName) {
    let n = sourceName;
    if (ext && n.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      n = n.slice(0, -(ext.length + 1));
    }
    base = n;
  }
  const displaySize = cloud?.size_bytes ?? file.sizeBytes;
  const displayDate = cloud?.uploaded_at || file.mtimeIso;
  // Tooltip shows just the basename (no extension) — mirrors the
  // card title. Optional "differs from cloud" line below it on
  // modified cards.
  const tooltipBody = modified
    ? `${base}\nDiffers from cloud version`
    : base;
  // Build the URL for the on-disk bytes — used as the descriptor's
  // `source` so the unified resolver can fetch + regenerate when the
  // cloud thumbnail is missing OR stale (after a local edit).
  //   • Electron → custom `localfile://` protocol (sync URL, streams
  //     bytes off disk; mtime appended as a cache-buster so an
  //     in-place edit produces a new URL the browser won't cache).
  //   • Web      → blob: URL built from the cached FSA handle. Built
  //     lazily in an effect because `getFile()` is async; revoked on
  //     unmount / path change to avoid leaking bytes.
  const isWebPath = typeof file.path === 'string' && file.path.startsWith('web://');
  const [webBlobUrl, setWebBlobUrl] = useState(null);
  useEffect(() => {
    if (!isWebPath) return undefined;
    let cancelled = false;
    let url = null;
    readLocalBlob(file.path).then((blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setWebBlobUrl(url);
    }).catch(() => { /* missing handle — resolver falls back to glyph */ });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setWebBlobUrl(null);
    };
    // mtime in deps so an in-place byte edit re-reads the file +
    // rebuilds a fresh blob URL — without this the descriptor's
    // `source.url` would keep pointing at the pre-edit bytes.
  }, [isWebPath, file.path, file.mtimeIso]);
  const localUrl = isWebPath
    ? webBlobUrl
    : (file.path
        ? `localfile://local/${encodeURIComponent(file.path)}${file.mtimeIso ? `?t=${encodeURIComponent(file.mtimeIso)}` : ''}`
        : null);

  // Single descriptor → resolver hook handles signing the cloud
  // thumbnail (when present + bytes-identical to local), regenerating
  // from on-disk bytes via the shared generator (when bytes have
  // changed locally OR no cloud thumb exists), and caching the result
  // under a contentKey that breaks on every save. Replaces ~120 lines
  // of inline state + effects that used to live here.
  const descriptor = useMemo(() => describeLocalFile({
    localFile: file,
    localUrl,
    cloud,
    bytesChanged,
    localContentHash,
  }), [
    file.path,
    file.name,
    file.mimeType,
    file.mtimeIso,
    localUrl,
    cloud?.id,
    cloud?.content_hash,
    cloud?.thumbnail_path,
    cloud?.storage_path,
    bytesChanged,
    localContentHash,
  ]);
  // Morphing pill — one element that's a hover-tooltip in its calm
  // state and a vertical context menu after a right-click. Sharing
  // the same DOM node lets us animate between the two shapes via
  // FLIP (see useLayoutEffect below) so the menu morphs smoothly
  // out of the pill using GPU-composable transforms only.
  //
  // State model:
  //   pillPos    — cursor coords when the pill is visible. null = hidden.
  //   menuMode   — when true, pill is sticky (ignores mouseleave),
  //                interactive (pointer-events:auto), and renders
  //                the menu items instead of the text.
  //   oldPillRectRef — bounding rect of the small tooltip pill at
  //                the moment of right-click, so the FLIP animation
  //                has a "from" size to scale up from.
  const [pillPos, setPillPos] = useState(null);
  const [menuMode, setMenuMode] = useState(false);
  const pillRef = useRef(null);
  const oldPillRectRef = useRef(null);

  const handleMouseMove = (e) => {
    if (menuMode) return;
    setPillPos({ x: e.clientX, y: e.clientY });
  };
  const handleMouseLeave = () => {
    if (menuMode) return;
    setPillPos(null);
  };
  const handleContextMenu = (e) => {
    e.preventDefault();
    // Snapshot the pill's current (tooltip-size) rect BEFORE the
    // menu-mode flip so the FLIP effect below has a "from" size to
    // scale up from. Captured here in the event handler rather than
    // in the effect because by the time the effect runs the DOM is
    // already at menu-size.
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    setPillPos({ x: e.clientX, y: e.clientY });
    setMenuMode(true);
  };
  const closeMenu = () => {
    setMenuMode(false);
    setPillPos(null);
    oldPillRectRef.current = null;
  };

  // Sticky-mode dismissal: outside click, Escape, or scroll.
  useEffect(() => {
    if (!menuMode) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    const onDown = (e) => {
      if (pillRef.current && pillRef.current.contains(e.target)) return;
      closeMenu();
    };
    const onScroll = () => closeMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuMode]);

  // Position-clamp — same recipe as the shared Tooltip: keep the pill
  // inside the viewport on both axes, snap on first mount so the
  // CSS transition doesn't visibly slide in from (0,0). Re-runs on
  // menu-mode flip too so the bigger menu shape gets re-clamped.
  useLayoutEffect(() => {
    if (!pillPos) return;
    const pill = pillRef.current;
    if (!pill) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(8, Math.min(pillPos.x + 8, vw - 8 - w));
    const y = Math.max(8, Math.min(pillPos.y + 8, vh - 8 - h));
    const isFirstSet = !pill.style.transform;
    if (isFirstSet) {
      pill.style.transition = 'none';
      pill.style.transform = `translate(${x}px, ${y}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      pill.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [pillPos, menuMode]);

  // FLIP morph — runs once on menu-mode entry. Concept:
  //   F (First) — captured in handleContextMenu as oldPillRectRef.
  //   L (Last)  — measured right here, after React has committed the
  //               .is-menu shape change.
  //   I (Invert) — apply an inline transform that scales the pill
  //               DOWN so it visually matches the old tooltip size.
  //   P (Play)  — transition back to scale(1) using a transform-only
  //               animation, which composites on the GPU and runs
  //               without layout-thrashing repaints.
  // The position-clamp effect above wrote `translate(x, y)` already;
  // we extend it to `translate(x, y) scale(sx, sy)` here, then animate
  // to `translate(x, y) scale(1)`.
  useLayoutEffect(() => {
    if (!menuMode) return;
    const oldRect = oldPillRectRef.current;
    if (!oldRect) return;
    const pill = pillRef.current;
    if (!pill) return;
    const newRect = pill.getBoundingClientRect();
    if (newRect.width === 0 || newRect.height === 0) {
      oldPillRectRef.current = null;
      return;
    }
    const sx = oldRect.width / newRect.width;
    const sy = oldRect.height / newRect.height;
    // Read the translate the position-clamp effect just set so we
    // can preserve it through the scale animation.
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(pill.style.transform || '');
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    pill.style.transformOrigin = 'top left';
    // Step 1: snap to the inverse-scale state (visually the old pill
    // size) with no transition so the browser doesn't animate the
    // setup move.
    pill.style.transition = 'none';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
    // Force a reflow so the snap commits before we add the
    // transition for the play phase.
    void pill.offsetWidth;
    // Step 2: animate transform back to identity scale.
    pill.style.transition = 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(1, 1)`;
    oldPillRectRef.current = null;
  }, [menuMode]);

  // Selection fires instantly on single click — no delay. Selecting
  // and "open" don't actually conflict: double-clicking just
  // selects + opens, which matches how Explorer behaves anyway.
  // Both handlers stopPropagation so the panel's bg-click deselect
  // doesn't fire on the same event.
  //
  // Properties (the side-pane modal) is reachable via the right-
  // click menu item — selection alone never opens it.
  const handleCardClick = (e) => {
    e?.stopPropagation?.();
    onSelect?.(file);
  };
  const handleCardDoubleClick = (e) => {
    e?.stopPropagation?.();
    onDoubleOpen?.(file);
  };

  const handleMenuProperties = () => {
    closeMenu();
    onOpen?.(file);
  };
  const handleMenuRename = () => {
    closeMenu();
    onRename?.(file);
  };

  // Inline rename — driven by the parent's `isRenaming` prop. The
  // textarea is UNCONTROLLED (defaultValue + read-via-ref on commit)
  // so the displayed value can never drift from the current file's
  // name. A previous controlled-input attempt had a race where the
  // useState initializer + delayed effect could leave renameValue
  // out of sync with file.name (the user would type into what
  // looked like card A's input but the bound state held card B's
  // name, and the rename submitted with the wrong target). With
  // defaultValue read fresh on each rename entry, there's no React
  // state to fall out of date — the DOM input owns the value.
  //
  // On entering rename mode, focus the input and select just the
  // basename (everything before the last "."), matching Windows
  // Explorer's F2 behaviour so the user types only the new base
  // and the extension is preserved.
  const renameInputRef = useRef(null);
  // Guard against commitRename firing twice (once on Enter →
  // intentional commit; once on the resulting blur from the
  // unmount). Reset each time the user enters rename mode.
  const renameCommittedRef = useRef(false);
  useEffect(() => {
    if (!isRenaming) return;
    renameCommittedRef.current = false;
    const el = renameInputRef.current;
    if (!el) return;
    // Reset value to the current file.name so a previous edit
    // session's stale text can't leak through (defaultValue alone
    // only seeds on first mount). The textarea is inside an
    // `{isRenaming ? ... : ...}` branch, so this is a fresh mount,
    // but assigning explicitly is belt-and-suspenders against any
    // future React reconciliation surprise.
    el.value = file.name || '';
    el.focus();
    const name = file.name || '';
    const lastDot = name.lastIndexOf('.');
    const end = lastDot > 0 ? lastDot : name.length;
    try { el.setSelectionRange(0, end); }
    catch { /* legacy quirk, ignore */ }
    // Size the textarea to fit the initial value so long names show
    // their wrapped layout immediately rather than scrolling inside
    // a one-line box on first paint.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [isRenaming, file.name]);

  const commitRename = () => {
    if (!isRenaming) return;
    if (renameCommittedRef.current) return;  // Enter already fired commit
    renameCommittedRef.current = true;
    const raw = renameInputRef.current?.value ?? '';
    const next = raw.trim();
    if (!next || next === file.name) {
      onRenameCancel?.();
      return;
    }
    onRenameSubmit?.(file, next);
  };

  const handleRenameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRenameCancel?.();
    }
  };
  const handleMenuRevert = () => {
    closeMenu();
    onRevert?.(file);
  };
  const handleMenuShowInFolder = () => {
    closeMenu();
    if (file?.path) localFolderApi.showInFolder(file.path);
  };
  const handleMenuDelete = () => {
    closeMenu();
    onDelete?.(file);
  };

  return (
    <div
      className="project-files-local-card-wrap"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onContextMenu={handleContextMenu}
    >
      {/* Outer wrapper is a div (not a button) so it can contain
          the inline rename <input> — buttons can't contain
          interactive elements per HTML spec. role + tabIndex +
          keyboard handler preserve the button-equivalent
          semantics (Space/Enter activate). Disabled while
          renaming so a stray click on the surrounding tile
          doesn't kick us out of edit mode unexpectedly — only
          the input's blur/Esc/Enter dismisses. */}
      <div
        role="button"
        tabIndex={isRenaming ? -1 : 0}
        className={`project-files-card${selected ? ' is-selected' : ''}`}
        onClick={isRenaming ? undefined : handleCardClick}
        onDoubleClick={isRenaming ? undefined : handleCardDoubleClick}
        onKeyDown={isRenaming ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleCardClick();
          }
        }}
      >
        <div
          className="project-files-thumb"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {/* Single descriptor — the resolver picks cloud thumb (when
              bytes match) or regenerates from on-disk bytes (when
              local has diverged), with consistent caching and DOCX
              rich-render across surfaces. The video hover slideshow
              lights up here too when `cloud.thumbnail_frames` exist. */}
          <FileThumbnail descriptor={descriptor} hovered={hovered} />
          {ext && (
            <span className="project-files-ext" aria-hidden="true">
              {ext.toUpperCase()}
            </span>
          )}
        </div>
        <div className="project-files-meta">
          {isRenaming ? (
            <textarea
              ref={renameInputRef}
              rows={1}
              className="project-files-name-input"
              // Uncontrolled — the DOM input owns the value. Seeded
              // with the current file.name on mount; commit reads
              // `renameInputRef.current.value` directly.
              defaultValue={file.name}
              onInput={(e) => {
                // Auto-grow: reset height so the next scrollHeight
                // measurement isn't capped by the previous frame.
                // CSS max-height clips at 4 lines and switches to
                // scroll once the textarea would exceed it.
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${el.scrollHeight}px`;
              }}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              // Swallow clicks so the card's onClick (select toggle)
              // doesn't fire while the user is editing the name.
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label="Rename file"
            />
          ) : (
            <div className="project-files-name">{base || file.name}</div>
          )}
        </div>
      </div>
      {modified && (
        <span className="project-files-modified-pill" aria-label="Local changes">
          Modified
        </span>
      )}
      {pillPos && createPortal(
        <div
          ref={pillRef}
          className={`tooltip project-files-morph-pill${menuMode ? ' is-menu' : ''}`}
          role={menuMode ? 'menu' : 'tooltip'}
          // In menu mode, cursor leaving the pill dismisses it. The
          // base tooltip is pointer-events:none so this never fires
          // for the non-menu state — only the `.is-menu` rule turns
          // pointer-events on, which is what makes the menu hoverable
          // AND what makes mouseleave fire when the cursor exits.
          onMouseLeave={menuMode ? closeMenu : undefined}
        >
          {menuMode ? (
            <ul className="project-files-morph-list">
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-files-morph-item"
                  onClick={handleMenuProperties}
                >
                  Properties
                </button>
              </li>
              {onRename && (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-files-morph-item"
                    onClick={handleMenuRename}
                  >
                    Rename
                  </button>
                </li>
              )}
              {/* Revert — only when the file has been modified locally
                  AND there's a cloud counterpart to revert to. Pulls
                  the canonical bytes from main and overwrites the local
                  copy. The auto-commit timer naturally clears the
                  Modified pill afterward (the diff goes empty for
                  this file). */}
              {onRevert && modified && cloud && (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-files-morph-item"
                    onClick={handleMenuRevert}
                  >
                    Revert
                  </button>
                </li>
              )}
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-files-morph-item"
                  onClick={handleMenuShowInFolder}
                  disabled={!file?.path}
                >
                  Show in explorer
                </button>
              </li>
              {onDelete && (
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    className="project-files-morph-item project-files-morph-item-danger"
                    onClick={handleMenuDelete}
                  >
                    Delete
                  </button>
                </li>
              )}
            </ul>
          ) : (
            <span className="project-files-morph-text">{tooltipBody}</span>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Inspector for a local-only My-branch file (no cloud counterpart
// yet, so no Supabase storage_path). Resolves a preview URL pointing
// at the on-disk bytes: `localfile://` on Electron, a blob: URL from
// the cached FSA file handle on web. The blob URL is revoked on
// unmount so we don't leak memory across opens. Hands the URL to
// FileDetailModal via `previewUrlOverride` — which bypasses the
// Supabase signing path so the modal renders the image / video / PDF
// straight from disk.
function LocalOnlyFileDetail({ localFile, projectId, viewerId, onClose }) {
  const isWebPath = typeof localFile?.path === 'string' && localFile.path.startsWith('web://');
  const mtime = localFile?.mtimeIso || null;
  const [webBlobUrl, setWebBlobUrl] = useState(null);
  useEffect(() => {
    if (!isWebPath || !localFile?.path) return undefined;
    let cancelled = false;
    let url = null;
    readLocalBlob(localFile.path).then((blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setWebBlobUrl(url);
    }).catch(() => { /* handle missing — modal falls back to glyph */ });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setWebBlobUrl(null);
    };
    // mtime in deps so an in-place byte edit re-reads the file and
    // recreates the blob URL — without it the preview would freeze
    // on the bytes the modal happened to capture at mount time.
  }, [isWebPath, localFile?.path, mtime]);
  const previewUrl = isWebPath
    ? webBlobUrl
    : (localFile?.path
        ? `localfile://local/${encodeURIComponent(localFile.path)}${mtime ? `?t=${encodeURIComponent(mtime)}` : ''}`
        : null);
  return (
    <FileDetailModal
      file={{
        id: `local:${localFile.path}`,
        project_id: projectId,
        name: localFile.name,
        description: null,
        mime_type: localFile.mimeType || '',
        size_bytes: localFile.sizeBytes ?? 0,
        storage_path: '',
        thumbnail_path: null,
        thumbnail_frames: null,
        duration_seconds: null,
        content_hash: null,
        uploaded_by: viewerId,
        uploaded_at: localFile.mtimeIso || new Date().toISOString(),
      }}
      readOnly
      previewUrlOverride={previewUrl}
      onClose={onClose}
    />
  );
}

// Resolve a preview URL pointing at the on-disk bytes for a given
// local path. Mirrors the localfile:// (Electron) / blob: (web)
// dispatch that LocalOnlyFileDetail uses, but as a reusable hook so
// the modal opened for a cloud-backed-but-locally-edited file can
// share the same resolution and revocation semantics.
//
// `mtime` is folded in as a cache-buster so an in-place byte edit
// (same path, new contents) breaks every layer of caching:
//   • Electron localfile:// — Chromium caches by URL; the `?t=mtime`
//     query string makes the URL unique per save, forcing a fresh
//     stream off disk. The main-process handler keys off pathname
//     only, so the suffix doesn't change resolution.
//   • Web blob: — the underlying File object is read freshly each
//     time the effect re-runs; `mtime` in the dep array makes that
//     re-run on every save instead of staying pinned to the first
//     blob URL until the path changes.
function useLocalPreviewUrl(path, mtime) {
  const isWebPath = typeof path === 'string' && path.startsWith('web://');
  const [webBlobUrl, setWebBlobUrl] = useState(null);
  useEffect(() => {
    if (!isWebPath || !path) return undefined;
    let cancelled = false;
    let url = null;
    readLocalBlob(path).then((blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setWebBlobUrl(url);
    }).catch(() => { /* missing — modal falls back to cloud / glyph */ });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setWebBlobUrl(null);
    };
  }, [isWebPath, path, mtime]);
  if (!path) return null;
  if (isWebPath) return webBlobUrl;
  const base = `localfile://local/${encodeURIComponent(path)}`;
  return mtime ? `${base}?t=${encodeURIComponent(mtime)}` : base;
}

// Wraps FileDetailModal for a cloud-row whose local bytes diverge
// from the cloud version (My-branch local edit, not yet pushed).
// Resolves the local bytes to a preview URL and hands it to the
// modal as `previewUrlOverride` so the preview pane reflects what
// the file looks like NOW on disk — matching the card thumbnail's
// behavior — instead of the stale cloud bytes from the canonical
// bucket. Falls back to the modal's default cloud-signed flow if
// the local path is missing.
function MyBranchEditedFileDetail({
  file,
  localPath,
  localMtime,
  localContentHash,
  onClose,
  onDeleted,
  onLocalRename,
  readOnly,
}) {
  const localUrl = useLocalPreviewUrl(localPath, localMtime);
  // The DOCX preview generator caches its rich-rendered image by
  // `content_hash || signedUrl`. The cloud row's content_hash is the
  // PRE-edit hash, so without override the cache returns the stale
  // pre-edit rendering even after the URL has been busted by mtime.
  // Swap the hash with the (post-edit) local hash when known; fall
  // back to `null` so the cache keys on the cache-busted URL.
  const effectiveFile = file
    ? { ...file, content_hash: localContentHash || null }
    : file;
  return (
    <FileDetailModal
      file={effectiveFile}
      previewUrlOverride={localUrl}
      onClose={onClose}
      onDeleted={onDeleted}
      onLocalRename={onLocalRename}
      readOnly={readOnly}
    />
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
  const { session } = useAuth();
  const userId = session?.user?.id || null;

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The currently-open file detail modal. Holds only the id of the
  // selected file — the actual file row is re-resolved from `files`
  // every render so realtime UPDATE / DELETE events automatically
  // flow into the modal's prop (and a DELETE event reduces the prop
  // to null, which the modal interprets as "auto-close").
  const [openFileId, setOpenFileId] = useState(null);
  // Local-only inspector — opened when the user clicks (or right-click →
  // Open) a My-branch card whose file isn't yet linked to a cloud row.
  // Holds the localFile snapshot directly; the modal mounts in readOnly
  // mode against a synthesized cloud-row shape (no DB metadata to edit
  // since the file hasn't been pushed).
  const [openLocalOnlyFile, setOpenLocalOnlyFile] = useState(null);
  // Selection highlight for My-branch local cards. Single click sets
  // this; the side-pane modal is gated on a separate state and is
  // reached only via right-click → Properties. Keyed by `file.path`
  // so a re-render with the same disk path keeps the selection.
  const [selectedLocalPath, setSelectedLocalPath] = useState(null);
  // Inline rename — `file.path` of the card currently in rename
  // mode, or null. Mirrors the F2-rename pattern from Explorer:
  // right-click → Rename flips the card's name slot into an
  // <input>; Enter commits via handleRenameSubmit, Escape / blur
  // dismisses via handleRenameCancel.
  const [renamingPath, setRenamingPath] = useState(null);
  // My-branch scope toggle. "all" (default) renders both the files
  // on disk AND any main-branch files missing from disk as ghost
  // cards (the existing "missing — click to download" overlay).
  // "local" hides those ghosts so the grid only shows files the
  // user actually has on disk. Persisted per-project so the choice
  // sticks across navigations / reloads.
  const MY_SCOPE_KEY = projectId ? `docvex:project-files-my-scope:${projectId}` : null;
  const [myBranchScope, setMyBranchScope] = useState(() => {
    if (!MY_SCOPE_KEY) return 'all';
    try {
      const cached = localStorage.getItem(MY_SCOPE_KEY);
      return cached === 'local' ? 'local' : 'all';
    } catch { return 'all'; }
  });
  useEffect(() => {
    if (!MY_SCOPE_KEY) return;
    try { localStorage.setItem(MY_SCOPE_KEY, myBranchScope); }
    catch { /* private mode — fall back to in-memory only */ }
  }, [MY_SCOPE_KEY, myBranchScope]);
  // Upload modal open/close now lives in UploadsContext so drag-drop
  // events (handled in the context's window listener) can still open
  // it from any route. The FAB on this page no longer opens the
  // cloud-upload modal — on 'mine' it writes files straight to the
  // bound local folder. Keep the import-free so any future page-level
  // hook into uploads can re-introduce it cleanly.
  const { notify } = useNotifications();
  // Branch view + queued changes. When `view === 'mine'` the cloud
  // panel paints overlay badges on cards that have a matching
  // branch_changes row, and shows extra rows for queued 'add' items.
  const {
    view: branchView,
    setView: setBranchViewRaw,
    overlayByFileId,
    addedChanges,
    pendingChanges,
    requests: changeRequests,
    openOwnRequestItems,
    isAdmin: viewerIsAdmin,
    isMember: viewerIsMember,
    isBehindMain,
    refresh: refreshBranchState,
    queueChange,
    refreshOpenRequestItems,
  } = useBranch();
  // Modals: revert-to-main (SyncToMainModal — pulls main into local
  // AND discards queued changes; wired to the "Revert to main branch"
  // button + the "New update on main" status chip), commit-changes
  // (push current local branch state for review; wired to the
  // "Changes made" status chip). Change-request review used to be a
  // third modal here; it now lives as the "Version control" tab on
  // the Project Dashboard. The status pills below navigate there.
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const openRequestsCount = useMemo(
    () => changeRequests.filter((r) => r.status === 'open').length,
    [changeRequests],
  );

  // Navigate to the dashboard's Version control tab — used by both
  // the always-visible "Change requests" pill (Main tab) and the
  // "Awaiting review" pill that lights up after a successful push.
  // Falls back to a no-op when there's no selected project, which
  // shouldn't happen here (this page itself requires one) but stays
  // defensive against future entry points.
  const navigate = useNavigate();
  const openVersionControl = useCallback(() => {
    if (!projectId) return;
    navigate(`/projects/${projectId}/dashboard?tab=version-control`);
  }, [navigate, projectId]);

  // ── Local-folder sync state ───────────────────────────────────────────
  // localFolder is the absolute path the user picked (or typed) as the
  // sync target. localFiles is what's actually in that directory right
  // now (refreshed after the sync modal applies, and when the user
  // changes the path).
  const [localFolder, setLocalFolder] = useState('');
  const [localFiles, setLocalFiles] = useState([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState(null);

  // Background SHA-256 cache for local files — keyed by
  // `${name}|${mtimeIso}` so an Explorer edit (which bumps mtime)
  // invalidates the entry automatically. The hashing effect below
  // walks `localFiles` whenever it changes and fills the map; the
  // diff effect re-runs as entries land, so the UI gracefully
  // upgrades from a size-based diff to a hash-based one over a
  // second or two on first load.
  const [localHashByName, setLocalHashByName] = useState(new Map());
  const hashCacheRef = useRef(new Map()); // `${name}|${mtime}` → hex
  // Cloud-side hash backfill — for `project_files` rows whose
  // `content_hash` column is null (legacy rows uploaded before
  // migration 014), the renderer fetches the file via signed URL,
  // hashes it once, and caches the result keyed by file id. Used as
  // a fallback by computeBranchDiff so same-size edits to legacy
  // files still surface as 'replace'.
  const [cloudHashByFileId, setCloudHashByFileId] = useState(new Map());
  const cloudHashCacheRef = useRef(new Map()); // file.id → hex

  // Sidecar — the per-(project, localFolder) source of truth for
  // "this on-disk filename IS this fileId". Matching across the
  // entire branch flow runs through this map; the old name / display-
  // name / hash fallback stack is gone. See lib/localBranchMeta.js
  // for the full rationale, the bootstrap path, and the
  // reconciliation semantics. State here so writes (FAB add, modal
  // rename, sync-to-main download) trigger React updates that
  // recompute the diff in the same render.
  const [sidecar, setSidecar] = useState(() => emptySidecar(null, null));
  // Load the sidecar whenever the (project, folder) tuple changes.
  // The empty-folder case still loads — sidecar carries the
  // projectId so a folder switch later finds the right scope.
  //
  // One-time migration: if the in-folder `.docvex.json` doesn't
  // exist yet, check the old localStorage key (where the sidecar
  // used to live) and port it into the file. Lets existing users
  // keep their existing fileId mapping without re-bootstrapping
  // from scratch. Deletes the localStorage entry after a successful
  // migration so we don't re-import on every load.
  useEffect(() => {
    if (!projectId || !localFolder) {
      setSidecar(emptySidecar(projectId, localFolder));
      return;
    }
    let cancelled = false;
    (async () => {
      let loaded = await loadSidecar(projectId, localFolder);
      // Migration path — only fires when the in-folder sidecar
      // came back empty. Reads the legacy localStorage payload,
      // hydrates an in-memory sidecar from it, persists to file,
      // and clears the legacy key.
      if (loaded.byFileId.size === 0) {
        let legacyRaw = null;
        try { legacyRaw = localStorage.getItem(LEGACY_SIDECAR_KEY(projectId, localFolder)); }
        catch { /* private mode — skip migration */ }
        if (legacyRaw) {
          let legacyParsed = null;
          try { legacyParsed = JSON.parse(legacyRaw); }
          catch { /* malformed — drop it below */ }
          if (legacyParsed?.entries) {
            const migrated = emptySidecar(projectId, localFolder);
            for (const [fileId, entry] of Object.entries(legacyParsed.entries)) {
              if (!entry?.filename) continue;
              migrated.byFileId.set(fileId, {
                filename: entry.filename,
                contentHash: entry.contentHash || null,
                mtime: entry.mtime || null,
              });
              migrated.byFilename.set(entry.filename.toLowerCase(), fileId);
            }
            if (migrated.byFileId.size > 0) {
              // Persist before clearing the legacy key so a failed
              // write doesn't strand the mapping.
              const { ok } = await localFolderApi.writeSidecar({
                dir: localFolder,
                json: sidecarToPayload(migrated),
              });
              if (ok) {
                try { localStorage.removeItem(LEGACY_SIDECAR_KEY(projectId, localFolder)); }
                catch { /* swallow */ }
                loaded = migrated;
              }
            }
          }
        }
      }
      if (!cancelled) setSidecar(loaded);
    })();
    return () => { cancelled = true; };
  }, [projectId, localFolder]);
  // Sidecar reconciliation now happens inside computeSyncState below —
  // one pass produces both the reconciled sidecar AND the diff state.
  // This effect just persists the result when it changes. Keeping
  // the persist outside the memo so React state updates stay
  // side-effect-free during render.
  useEffect(() => {
    if (branchView !== 'mine' || !hasLocalFolderApi) return undefined;
    let cancelled = false;
    (async () => {
      // Iterate in declared order so the user sees results predictably.
      let dirty = false;
      const next = new Map(localHashByName);
      for (const f of localFiles) {
        if (cancelled) return;
        const cacheKey = `${f.name}|${f.mtimeIso}`;
        const cached = hashCacheRef.current.get(cacheKey);
        if (cached) {
          if (next.get(f.name.toLowerCase()) !== cached) {
            next.set(f.name.toLowerCase(), cached);
            dirty = true;
          }
          continue;
        }
        try {
          const blob = await readLocalBlob(f.path);
          const hex = await sha256Hex(blob);
          if (cancelled) return;
          hashCacheRef.current.set(cacheKey, hex);
          next.set(f.name.toLowerCase(), hex);
          dirty = true;
        } catch {
          // Skip — diff falls back to size comparison for this file.
        }
      }
      if (!cancelled && dirty) setLocalHashByName(next);
    })();
    return () => { cancelled = true; };
    // localHashByName is intentionally NOT a dep — that would loop
    // (the effect mutates it). Watching localFiles is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchView, localFiles]);

  // Cloud-hash backfill effect. Fetches + hashes every cloud file
  // that's missing a stored content_hash so legacy uploads (pre-
  // migration 014) participate in the hash-based diff. Files that
  // ALREADY have content_hash are skipped — they were uploaded
  // post-014 and we trust the stored value. Cache survives across
  // renders so we hash each legacy file at most once per session.
  useEffect(() => {
    if (branchView !== 'mine' || !hasLocalFolderApi) return undefined;
    let cancelled = false;
    (async () => {
      let dirty = false;
      const next = new Map(cloudHashByFileId);
      for (const cf of files) {
        if (cancelled) return;
        // Stored hash on the row trumps everything — pure read.
        if (cf.content_hash) {
          if (next.get(cf.id) !== cf.content_hash) {
            next.set(cf.id, cf.content_hash);
            dirty = true;
          }
          continue;
        }
        const cached = cloudHashCacheRef.current.get(cf.id);
        if (cached) {
          if (next.get(cf.id) !== cached) {
            next.set(cf.id, cached);
            dirty = true;
          }
          continue;
        }
        // No stored hash + no cached hash → fetch + hash.
        try {
          const { data, error } = await createSignedDownloadUrl(cf.storage_path, 600);
          if (cancelled) return;
          if (error || !data?.signedUrl) continue;
          const res = await fetch(data.signedUrl);
          if (!res.ok) continue;
          const blob = await res.blob();
          const hex = await sha256Hex(blob);
          if (cancelled) return;
          cloudHashCacheRef.current.set(cf.id, hex);
          next.set(cf.id, hex);
          dirty = true;
        } catch {
          // Skip — diff falls back to size compare for this file.
        }
      }
      if (!cancelled && dirty) setCloudHashByFileId(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchView, files]);

  // Soft hold for openOwnRequestItems across the post-approval
  // window. The realtime echo for a status flip (open → approved)
  // arrives a few hundred ms before the matching project_files
  // INSERT/UPDATE/DELETE echoes — so there's a window where:
  //   • BranchContext has already cleared openOwnRequestItems (the
  //     request is no longer open).
  //   • project_files state hasn't yet reflected the merge.
  //   • branchDiff therefore re-emits the just-merged items as
  //     fresh add/replace entries → "Changes made" chip flickers
  //     back on, per-card Modified pills repaint.
  // The hold snapshots the items at approval time and keeps them
  // in the filter set for ~4s, smoothing the transition. A ref
  // captures the snapshot — state updates in the same React tick
  // can race against the items-clear that follows.
  const lastOpenItemsRef = useRef([]);
  const [heldApprovedItems, setHeldApprovedItems] = useState([]);
  const holdTimerRef = useRef(null);

  useEffect(() => {
    if ((openOwnRequestItems || []).length > 0) {
      lastOpenItemsRef.current = openOwnRequestItems;
    }
  }, [openOwnRequestItems]);

  useEffect(() => () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
  }, []);

  // Effective "in flight" set the diff treats as already pushed.
  // Falls back to live items when no hold is active so steady-state
  // behaviour is unchanged.
  const effectiveOpenItems = useMemo(
    () => (heldApprovedItems.length > 0
      ? [...(openOwnRequestItems || []), ...heldApprovedItems]
      : (openOwnRequestItems || [])),
    [openOwnRequestItems, heldApprovedItems],
  );

  // Unified sync-state computation. One pass over all the inputs
  // produces: reconciled sidecar, per-fileId rows (for the per-card
  // render), toCommit (auto-commit input), toSync (revert-modal
  // input), summary (status pill source), and openRequestDeleteIds
  // (missing-card filter). Replaces three previous separate diffs.
  // See src/lib/syncState.js for the trust hierarchy and the row
  // classification logic.
  const syncState = useMemo(
    () => (branchView === 'mine'
      ? computeSyncState({
        localFiles,
        cloudFiles: files,
        sidecar,
        pendingChanges,
        openRequestItems: effectiveOpenItems,
        localHashByName,
        cloudHashByFileId,
      })
      : null),
    [branchView, localFiles, files, sidecar, pendingChanges, effectiveOpenItems, localHashByName, cloudHashByFileId],
  );

  // Persist the reconciled sidecar back to disk + React state when
  // the in-memory shape moved. The memo above is pure; this effect
  // is the only writer.
  useEffect(() => {
    if (!syncState || !syncState.sidecarChanged) return;
    setSidecar(syncState.sidecar);
    saveSidecar(syncState.sidecar);
  }, [syncState]);

  // Compatibility shim: the existing auto-commit and per-card render
  // code wants the legacy "branchDiff" array. toCommit is the same
  // shape (items carry kind/local/cloud/fileId), so we expose it
  // under the old name to keep downstream untouched.
  const branchDiff = syncState?.toCommit || [];

  // ── Manual push ────────────────────────────────────────────────────
  // The "auto-commit on edit" pattern is gone — users wanted control
  // over when work goes out for review. A single Push button on the
  // "You have unsaved edits" pill triggers a one-shot push of every
  // currently-detected local change. No title / description prompt;
  // the title is a date-based string for the reviewer's audit log,
  // same as the old auto-push generated.
  //
  // `pushing` gates the button to prevent double-clicks; refresh of
  // `openOwnRequestItems` after success makes the pill flip from
  // "unsaved" to "waiting for review" in the same render.
  const [pushing, setPushing] = useState(false);
  const handlePush = useCallback(async () => {
    if (pushing) return;
    if (branchView !== 'mine') return;
    if (!projectId || !userId) return;
    const snapshot = buildCommitSnapshot({
      fsDiff: branchDiff,
      pendingChanges,
    });
    if (snapshot.length === 0) return;
    setPushing(true);
    try {
      const dateStr = new Date().toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      });
      const { error: pushErr } = await runCommitFlow({
        projectId,
        userId,
        snapshot,
        title: `Changes — ${dateStr}`,
        description: '',
      });
      if (pushErr) {
        notify?.({
          category: 'file',
          variant: 'error',
          title: 'Could not send edits',
          body: pushErr.message || String(pushErr),
          dedupeKey: `push-fail:${Date.now()}`,
        });
      } else {
        await refreshOpenRequestItems?.();
        notify?.({
          category: 'file',
          variant: 'success',
          icon: 'check',
          title: 'Edits sent',
          body: 'Your edits are waiting for review.',
          dedupeKey: `push-ok:${Date.now()}`,
        });
      }
    } finally {
      setPushing(false);
    }
  }, [pushing, branchView, projectId, userId, branchDiff, pendingChanges, notify, refreshOpenRequestItems]);

  // Per-card "modified" indicator: derived from syncState.rows so it
  // mirrors the status pill exactly. Includes BOTH 'replace' (bytes
  // changed) AND 'rename' (name changed) — both are pending edits
  // from the user's perspective.
  const diffReplaceCloudIds = useMemo(() => {
    const s = new Set();
    if (!syncState) return s;
    for (const row of syncState.rows.values()) {
      if ((row.status === 'replace' || row.status === 'rename') && row.cloud) {
        s.add(row.cloud.id);
      }
    }
    return s;
  }, [syncState]);

  // Narrower set: cloud ids whose LOCAL BYTES have diverged from the
  // cloud-stored bytes. Used by the per-card render to decide whether
  // to show the cloud-baked thumbnail (still accurate after a rename
  // alone) or the locally-regenerated thumbnail (only choice when the
  // file's content has changed locally — the cloud thumb is stale
  // until an admin approves a push). A rename-only divergence keeps
  // the cloud thumbnail.
  const bytesDifferCloudIds = useMemo(() => {
    const s = new Set();
    if (!syncState) return s;
    for (const row of syncState.rows.values()) {
      if (row.status === 'replace' && row.cloud) s.add(row.cloud.id);
    }
    return s;
  }, [syncState]);

  // Cloud rows queued for delete by an open (or recently-approved)
  // change request — the missing-card overlay suppresses these
  // because the cloud row is about to disappear.
  const openRequestDeleteIds = syncState?.openRequestDeleteIds || new Set();
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

  // Web-only: tracks "we have a persisted folder handle but the
  // browser needs the user's gesture to grant permission again."
  // True between page-load and the user's first Reconnect click.
  // Always false on Electron (paths are usable without gating).
  const [needsReconnect, setNeedsReconnect] = useState(false);

  // Hydrate the chosen folder when the project switches:
  //   • Electron: read the path from localStorage (sync, instant).
  //   • Web:      look up the FileSystemDirectoryHandle in IndexedDB
  //               (async). If found, show its name and gate file
  //               listing on a Reconnect click (FSA permission
  //               grants don't survive a reload by default).
  // Clearing on project switch avoids accidentally syncing project
  // A's files into project B's folder.
  useEffect(() => {
    if (!projectId) {
      setLocalFolder('');
      setLocalFiles([]);
      setLocalError(null);
      setNeedsReconnect(false);
      setHydratedProjectId(null);
      return undefined;
    }
    if (isElectronBranch) {
      let cached = '';
      try { cached = localStorage.getItem(LOCAL_FOLDER_KEY(projectId)) || ''; }
      catch { /* private-mode etc. — fall through with empty */ }
      setLocalFolder(cached);
      setLocalFiles([]);
      setLocalError(null);
      setNeedsReconnect(false);
      setHydratedProjectId(projectId);
      return undefined;
    }
    // Web restore path.
    let cancelled = false;
    setLocalFolder('');
    setLocalFiles([]);
    setLocalError(null);
    setNeedsReconnect(false);
    localFolderApi.restorePersistedHandle(projectId).then((restored) => {
      if (cancelled) return;
      if (restored) {
        setLocalFolder(restored.name);
        setNeedsReconnect(Boolean(restored.needsPermission));
      }
      setHydratedProjectId(projectId);
    });
    return () => { cancelled = true; };
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
    if (isElectronBranch && hydratedProjectId === projectId) {
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
    // Web restore window: handle is hot-loaded but permission isn't
    // granted yet. Calling list() would throw NotAllowedError; skip
    // until the user clicks Reconnect.
    if (needsReconnect) {
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
  }, [projectId, localFolder, hydratedProjectId, needsReconnect]);

  // Live-reload the local file list when the branch folder changes on
  // disk. main runs `fs.watch` (debounced 200ms) and pings us via
  // `local-folder:changed`; we re-list and React swaps the cards in
  // place. Solves the "I deleted a file in Explorer but the My branch
  // tab still shows it" gap AND clears the cascading 404 spam from
  // dead <img> elements after a delete (the cards unmount as soon as
  // the list refresh runs).
  useEffect(() => {
    if (!hasLocalFolderApi || !localFolder) return undefined;
    localFolderApi.watch(localFolder);
    const unsub = localFolderApi.onChange((changedDir) => {
      // The watcher is single-slot so any event we receive must be
      // for the currently-watched dir; the changedDir argument is
      // forwarded just so future multi-watch scenarios can scope.
      if (changedDir && changedDir !== localFolder) return;
      localFolderApi.list(localFolder).then(({ files: localList, error: listErr }) => {
        if (listErr) return;
        setLocalFiles(localList || []);
      });
    });
    return () => {
      unsub?.();
      localFolderApi.unwatch();
    };
  }, [localFolder]);

  // Open the native folder picker; main returns the absolute path or
  // null if the user canceled. On web the picker returns a
  // FileSystemDirectoryHandle name (the IDB persistence call below
  // saves the actual handle so the next visit can restore it).
  // No-op when no Electron / FSA API.
  const handleBrowseFolder = useCallback(async () => {
    if (!hasLocalFolderApi) return;
    const picked = await localFolderApi.pick();
    if (!picked) return;
    setLocalFolder(picked);
    setNeedsReconnect(false);
    // Web: stash the just-picked handle for next session. Idempotent
    // and a no-op on Electron, so we don't have to branch here.
    if (projectId) await localFolderApi.persistPickedHandle(projectId);
  }, [projectId]);

  // Web-only: re-grant permission on the persisted handle. The FSA
  // spec requires this to be inside a user gesture, which is why it
  // wears its own button rather than firing automatically on restore.
  // On success, clears the gate so the file-listing effect runs.
  const handleReconnect = useCallback(async () => {
    if (!hasLocalFolderApi) return;
    const ok = await localFolderApi.reconnectHandle();
    if (ok) {
      setNeedsReconnect(false);
    } else {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Folder access denied',
        body: 'Pick the folder again to reconnect.',
        dedupeKey: 'reconnect-folder-denied',
      });
    }
  }, [notify]);

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

  // Pull a single cloud file into the user's branch folder. Used by
  // the "missing from branch" cards — clicking one fills the gap
  // without re-running a full Download. Refreshes the local listing
  // on success so the card immediately disappears (the local match
  // now exists, so the "missing" filter excludes it next render).
  const handleDownloadOne = useCallback(async (cloudFile) => {
    if (!hasLocalFolderApi || !localFolder || !cloudFile?.storage_path) return;
    const { data, error: signErr } = await createSignedDownloadUrl(cloudFile.storage_path, 600);
    if (signErr || !data?.signedUrl) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Could not start download',
        body: signErr?.message || 'Try again in a moment.',
        dedupeKey: `download-one-sign:${cloudFile.id}`,
      });
      return;
    }
    const filename = cloudFile.storage_path.split('/').pop() || cloudFile.name;
    const { results, error: dlErr } = await localFolderApi.download({
      dir: localFolder,
      files: [{ url: data.signedUrl, filename }],
    });
    const ok = !dlErr && results?.[0]?.ok;
    if (!ok) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Download failed',
        body: dlErr || results?.[0]?.error || 'Unknown error',
        dedupeKey: `download-one-err:${cloudFile.id}`,
      });
      return;
    }
    notify({
      category: 'file',
      variant: 'success',
      icon: 'upload',
      title: 'Downloaded',
      body: cloudFile.name,
      dedupeKey: `download-one-ok:${cloudFile.id}`,
    });
    // Immediate sidecar entry — claim cloud.id for the local file
    // before the reconciliation pass would have to hash-match it
    // back. Skips the bootstrap window where the just-downloaded
    // file briefly has no fileId and the diff would treat it as
    // an orphan. Hash will fill in on the next background pass.
    setSidecar((prev) => {
      const next = addSidecarEntry(prev, cloudFile.id, {
        filename,
        contentHash: cloudFile.content_hash || null,
        mtime: new Date().toISOString(),
      });
      saveSidecar(next);
      return next;
    });
    const { files: localList } = await localFolderApi.list(localFolder);
    setLocalFiles(localList || []);
  }, [localFolder, notify]);

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

  // Manual cloud-files refetch — invoked on tab change so a viewer
  // returning to a tab always sees the latest state (covers realtime
  // gaps, e.g. branch_changes DELETEs that don't propagate without
  // REPLICA IDENTITY FULL). The realtime sub below still keeps the
  // list live between explicit refetches.
  const refetchCloudFiles = useCallback(async () => {
    if (!projectId) return;
    const { data, error: listErr } = await listProjectFiles(projectId);
    if (listErr) {
      setError(listErr.message || 'Failed to load files');
      return;
    }
    setFiles(data || []);
    writeCachedFilesCount(projectId, (data || []).length);
  }, [projectId]);

  // Manual local-folder refetch — re-lists the disk so a freshly-
  // approved request or an external rename shows up without waiting
  // on the watcher poll.
  const refetchLocalFiles = useCallback(async () => {
    if (!hasLocalFolderApi || !localFolder) return;
    const { files: localList, error: listErr } = await localFolderApi.list(localFolder);
    if (!listErr) setLocalFiles(localList || []);
  }, [localFolder]);

  // FAB-driven "add files to my branch" flow. Picks files via a hidden
  // <input type=file multiple>, then writes them directly into the
  // bound local folder. NO cloud round-trip on add — files live
  // locally until the user pushes via the Changes-made pill. The list
  // refresh after the write makes the new cards appear immediately.
  const localUploadInputRef = useRef(null);
  const handleLocalFilesPicked = useCallback(async (e) => {
    const input = e.target;
    const picked = Array.from(input.files || []);
    // Reset the input so picking the same files again still fires
    // onChange (browser de-dupes if value stays the same).
    input.value = '';
    if (picked.length === 0) return;
    if (!localFolder) return;
    const payload = picked.map((file) => ({ filename: file.name, blob: file }));
    const { results, error: writeErr } = await localFolderApi.writeFiles({
      dir: localFolder,
      files: payload,
    });
    if (writeErr) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Could not add files',
        body: writeErr,
        dedupeKey: 'fab-write-error',
      });
      return;
    }
    const okCount = (results || []).filter((r) => r.ok).length;
    const failCount = (results || []).length - okCount;
    notify({
      category: 'file',
      variant: failCount > 0 ? 'error' : 'success',
      title: failCount > 0 ? 'Added with errors' : 'Files added',
      body: failCount > 0
        ? `${okCount} of ${results.length} files added · ${failCount} failed`
        : `${okCount} file${okCount === 1 ? '' : 's'} added to your branch.`,
      dedupeKey: 'fab-write-result',
    });
    // Synchronously mint a fileId per successfully-written file and
    // park it in the sidecar. The reconciliation effect would catch
    // these too — but only after the background hasher runs, which
    // can take a second or two on larger files. By claiming the IDs
    // here, the new card resolves through the sidecar in the very
    // next render (matching, "modified" pill, drag-to-version-control
    // all work immediately). Hash backfills on the next reconcile.
    if (okCount > 0) {
      setSidecar((prev) => {
        let next = prev;
        for (const r of results || []) {
          if (!r.ok || !r.filename) continue;
          // Filename may have been sanitised by main.js; the result
          // carries the saved name. Skip if the file already has a
          // sidecar mapping (re-add of an existing file → keep id).
          const lcName = r.filename.toLowerCase();
          if (next.byFilename.has(lcName)) continue;
          const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          next = addSidecarEntry(next, id, {
            filename: r.filename,
            contentHash: null,
            mtime: new Date().toISOString(),
          });
        }
        if (next !== prev) saveSidecar(next);
        return next;
      });
    }
    await refetchLocalFiles();
  }, [localFolder, notify, refetchLocalFiles]);

  // Tab-change handler — flips the branch view AND fans out a fresh
  // fetch on every relevant data source so the user always lands on
  // up-to-date state. Cloud + local + branch state (pendingChanges,
  // requests, main_version) are all refreshed in parallel; if any
  // one is slow the others still update independently.
  const setBranchView = useCallback((next) => {
    setBranchViewRaw(next);
    refetchCloudFiles();
    refetchLocalFiles();
    refreshBranchState?.();
  }, [setBranchViewRaw, refetchCloudFiles, refetchLocalFiles, refreshBranchState]);

  // Auto-refetch on merge approval — when the user's own change_request
  // flips to 'approved', the cloud has just absorbed their changes
  // (project_files mutated, branch_changes consumed, main_version
  // bumped). Realtime echoes update most state, but branch_changes
  // DELETEs may not propagate without REPLICA IDENTITY FULL, leaving
  // stale overlays. A targeted refetch on the transition fixes that
  // without spamming refetches on every realtime tick.
  //
  // Also seeds the soft hold (heldApprovedItems) with the snapshot
  // captured in lastOpenItemsRef — see the hold rationale above
  // the effectiveOpenItems memo.
  const lastApprovedIdsRef = useRef(new Set());
  useEffect(() => {
    if (!userId) return;
    const currentlyApproved = new Set(
      (changeRequests || [])
        .filter((r) => r.author_id === userId && r.status === 'approved')
        .map((r) => r.id),
    );
    let isNewApproval = false;
    for (const id of currentlyApproved) {
      if (!lastApprovedIdsRef.current.has(id)) { isNewApproval = true; break; }
    }
    lastApprovedIdsRef.current = currentlyApproved;
    if (isNewApproval) {
      if (lastOpenItemsRef.current.length > 0) {
        setHeldApprovedItems(lastOpenItemsRef.current);
        if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
        holdTimerRef.current = setTimeout(() => {
          setHeldApprovedItems([]);
          holdTimerRef.current = null;
        }, 4000);
      }
      refetchCloudFiles();
      refetchLocalFiles();
      refreshBranchState?.();
    }
  }, [changeRequests, userId, refetchCloudFiles, refetchLocalFiles, refreshBranchState]);

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
        // On a replace-approval the storage object at the same path
        // gets overwritten with new bytes, but our in-memory signed
        // URL cache still holds the old URL for that path — and the
        // browser HTTP cache holds the bytes that URL fetched. Evict
        // both the storage_path AND thumbnail paths so the next sign
        // call returns a fresh URL (different token → browser cache
        // miss → new bytes). content_hash is the actual signal that
        // bytes diverged, but we also evict on a no-bytes-changed
        // update (e.g., rename) because clearing a couple of paths
        // is cheap and avoids missing a case.
        const bytesChanged = !oldRow || oldRow.content_hash !== newRow.content_hash;
        if (bytesChanged) {
          if (newRow.storage_path)   evictSignedUrlCache(newRow.storage_path);
          if (newRow.thumbnail_path) evictSignedUrlCache(newRow.thumbnail_path);
          if (Array.isArray(newRow.thumbnail_frames)) {
            for (const f of newRow.thumbnail_frames) evictSignedUrlCache(f);
          }
        }
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

  // Cloud files indexed by id — the sidecar maps each local file's
  // filename to a fileId, and we hop through this index to get the
  // actual cloud row. Memoised so the click handler + render loop
  // share a stable reference and don't rebuild on every render.
  const cloudById = useMemo(() => {
    const map = new Map();
    for (const f of files) {
      if (f?.id) map.set(f.id, f);
    }
    return map;
  }, [files]);

  // Click handler for cards on the My-branch (local) tab. With the
  // sidecar in play, matching is one hop: filename → fileId → cloud.
  // The previous filename / display-name / overlay / hash fallback
  // chain collapsed into the sidecar reconciliation pass, so this
  // handler stays in sync with whatever the render loop resolves.
  // Either path opens the FileDetailModal as a side-pane inspector;
  // we never auto-launch the OS app from a card click — the user
  // wants the right-side info pane, not a bytes-open.
  const handleOpenLocalCard = useCallback((localFile) => {
    const lcName = (localFile.name || '').toLowerCase();
    const fileId = sidecar.byFilename.get(lcName);
    const cloud = fileId ? cloudById.get(fileId) : null;
    if (cloud) setOpenFileId(cloud.id);
    else setOpenLocalOnlyFile(localFile);
  }, [sidecar, cloudById]);

  // Right-click → Delete from the My-branch card's context menu.
  // Two paths depending on whether the file has a cloud counterpart:
  //   • Cloud-backed: queue a `delete` branch_change targeting the
  //     cloud row. Reversible until the user pushes — same flow as
  //     the FileDetailModal's Delete button. No confirm needed; the
  //     queued state is visible on the card (the DELETED overlay
  //     pill) and discardable from the Commit modal.
  //   • Local-only (sidecar-minted UUID, no cloud match yet): no
  //     cloud row to mark for delete, so this is a true filesystem
  //     remove. window.confirm() guards the destructive step since
  //     the on-disk file isn't recoverable from the app.
  const handleDeleteLocalCard = useCallback(async (localFile) => {
    if (!localFile?.name) return;
    if (!hasLocalFolderApi || !localFolder) return;
    // Local-only delete — no branch_change, no commit, no cloud
    // side effect. Per user direction: My-branch deletes are
    // purely "remove from my working copy", and file removal on
    // main is handled exclusively from the Main tab (admin
    // "Delete all files" or per-file delete via the modal).
    //
    // If the file had a cloud counterpart, it will re-surface as a
    // "missing — download" card on My branch on the next render
    // (cloud row exists, local file doesn't). That's the expected
    // shape: the user can re-pull it or ignore it.
    // eslint-disable-next-line no-alert
    const ok = window.confirm(`Permanently delete "${localFile.name}" from your local folder?`);
    if (!ok) return;
    const { error: delErr } = await localFolderApi.deleteFiles({
      dir: localFolder,
      paths: [localFile.path],
    });
    if (delErr) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Could not delete file',
        body: delErr,
        dedupeKey: `delete-local-error:${localFile.path}`,
      });
      return;
    }
    setSidecar((prev) => {
      const next = removeSidecarByFilename(prev, localFile.name);
      if (next !== prev) saveSidecar(next);
      return next;
    });
    await refetchLocalFiles();
    notify({
      category: 'file',
      variant: 'success',
      icon: 'trash',
      title: 'File deleted',
      body: localFile.name,
      dedupeKey: `delete-local-ok:${localFile.path}`,
    });
  }, [notify, localFolder, refetchLocalFiles]);

  // Single-click selection — just highlights the card. Re-clicking
  // the already-selected card deselects (matches OS file managers).
  const handleSelectLocalCard = useCallback((localFile) => {
    setSelectedLocalPath((prev) => (prev === localFile.path ? null : localFile.path));
  }, []);

  // F2 on a selected card → enter rename mode. Matches Windows
  // Explorer's keyboard affordance. Bailed when a card is already
  // in rename mode (the textarea would otherwise consume the key
  // before we see it, but we guard explicitly for completeness)
  // and when focus is in an input / textarea / contentEditable
  // elsewhere in the app so F2 doesn't hijack other text fields.
  useEffect(() => {
    if (!selectedLocalPath) return undefined;
    const onKey = (e) => {
      if (e.key !== 'F2') return;
      if (renamingPath) return;
      const target = e.target;
      const tag = (target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      e.preventDefault();
      setRenamingPath(selectedLocalPath);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedLocalPath, renamingPath]);

  // Right-click → Rename. Flips the card into inline-rename mode;
  // the actual on-disk rename runs in handleRenameSubmit when the
  // user commits via Enter / blur.
  const handleRenameLocalCard = useCallback((localFile) => {
    if (!localFile?.path) return;
    setRenamingPath(localFile.path);
  }, []);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  // Commits an inline rename — performs the on-disk rename, threads
  // the change through the sidecar (same fileId, new filename) and
  // queues a metadata edit for cloud-backed files so the rename
  // rides into the next change request as a proper edit (not a
  // delete-then-add). The auto-commit timer picks up the resulting
  // branch_changes row + local diff entry on its next tick.
  const handleRenameSubmit = useCallback(async (localFile, nextName) => {
    setRenamingPath(null);
    if (!hasLocalFolderApi || !localFolder || !localFile?.name) return;
    const toName = (nextName || '').trim();
    if (!toName || toName === localFile.name) return;
    // Preserve the on-disk extension when the user types just the
    // base — losing it would break the OS file-type association.
    const lastDot = localFile.name.lastIndexOf('.');
    const ext = lastDot > 0 ? localFile.name.slice(lastDot + 1) : '';
    let finalName = toName;
    if (ext && !finalName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
      finalName = `${finalName}.${ext}`;
    }
    if (finalName === localFile.name) return;
    // Snapshot the sidecar fileId BEFORE the rename / sidecar swap.
    // After renameSidecarEntry runs the old filename is gone from
    // byFilename, so the cloud lookup below has to come from the
    // pre-rename name.
    const lcOldName = (localFile.name || '').toLowerCase();
    const fileId = sidecar.byFilename.get(lcOldName);
    const cloud = fileId ? cloudById.get(fileId) : null;
    const { error } = await localFolderApi.renameFile({
      dir: localFolder,
      fromName: localFile.name,
      toName: finalName,
    });
    if (error) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Rename failed',
        body: error,
        dedupeKey: `rename-local-error:${localFile.path}`,
      });
      return;
    }
    // Sidecar follows the rename — same fileId, new filename — so
    // the next reconcile + diff match correctly. We snapshotted
    // fileId above so the cloud queueChange below can still find
    // the right target_file_id after the byFilename map updates.
    setSidecar((prev) => {
      const nextSc = renameSidecarEntry(prev, localFile.name, finalName);
      if (nextSc !== prev) saveSidecar(nextSc);
      return nextSc;
    });
    if (cloud) {
      await queueChange({
        kind: 'edit',
        targetFileId: cloud.id,
        proposed: { name: finalName },
      });
    }
    await refetchLocalFiles();
    notify({
      category: 'file',
      variant: 'success',
      icon: 'check',
      title: 'Renamed',
      body: `${localFile.name} → ${finalName}`,
      dedupeKey: `rename-local-ok:${localFile.path}`,
    });
  }, [localFolder, notify, sidecar, cloudById, queueChange, refetchLocalFiles]);

  // Right-click → Revert. Pulls the canonical bytes from main and
  // overwrites the local copy, dropping any in-progress local edits
  // to this file. Only meaningful when there's a cloud counterpart
  // — the menu item is gated on that AND on `modified` in
  // LocalFileCard, so this handler can assume both.
  const handleRevertLocalCard = useCallback(async (localFile) => {
    if (!hasLocalFolderApi || !localFolder) return;
    const lcName = (localFile.name || '').toLowerCase();
    const fileId = sidecar.byFilename.get(lcName);
    const cloud = fileId ? cloudById.get(fileId) : null;
    if (!cloud?.storage_path) return;
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Revert "${localFile.name}" to the main-branch version?\n\n`
      + 'Your local edits to this file will be lost.',
    );
    if (!ok) return;
    const { data, error: signErr } = await createSignedDownloadUrl(cloud.storage_path, 600);
    if (signErr || !data?.signedUrl) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Revert failed',
        body: signErr?.message || 'Could not sign the cloud version URL.',
        dedupeKey: `revert-sign-error:${cloud.id}`,
      });
      return;
    }
    // If the cloud's filename differs from local (post-rename
    // queued locally), drop the local file first so the download
    // doesn't leave both names on disk.
    const cloudFilename = (cloud.storage_path || '').split('/').pop()
      || cloud.name || localFile.name;
    if (cloudFilename.toLowerCase() !== lcName) {
      await localFolderApi.deleteFiles({
        dir: localFolder,
        paths: [localFile.path],
      }).catch(() => { /* swallow — the download still writes the canonical name */ });
      setSidecar((prev) => {
        const nextSc = removeSidecarByFilename(prev, localFile.name);
        if (nextSc !== prev) saveSidecar(nextSc);
        return nextSc;
      });
    }
    const { results, error: dlErr } = await localFolderApi.download({
      dir: localFolder,
      files: [{ url: data.signedUrl, filename: cloudFilename }],
    });
    if (dlErr || !results?.[0]?.ok) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Revert failed',
        body: dlErr || results?.[0]?.error || 'Could not write the file.',
        dedupeKey: `revert-download-error:${cloud.id}`,
      });
      return;
    }
    // Sidecar adopts the cloud id at the canonical filename so the
    // next reconcile + diff don't treat this as a fresh add.
    setSidecar((prev) => {
      const nextSc = addSidecarEntry(prev, cloud.id, {
        filename: cloudFilename,
        contentHash: cloud.content_hash || null,
        mtime: new Date().toISOString(),
      });
      saveSidecar(nextSc);
      return nextSc;
    });
    // Prime the hash map with the cloud hash so the per-card
    // "Modified" pill clears this render instead of waiting on the
    // background re-hasher.
    if (cloud.content_hash) {
      setLocalHashByName((prev) => {
        const next = new Map(prev);
        next.set(cloudFilename.toLowerCase(), cloud.content_hash);
        return next;
      });
    }
    await refetchLocalFiles();
    notify({
      category: 'file',
      variant: 'success',
      icon: 'check',
      title: 'Reverted',
      body: `"${cloudFilename}" matches main again.`,
      dedupeKey: `revert-ok:${cloud.id}`,
    });
  }, [sidecar, cloudById, localFolder, notify, refetchLocalFiles]);

  // Admin-only "wipe main" action — surfaced as the second pill in
  // the Main-tab status row. Hard-deletes every project_files row
  // (and its storage object via deleteProjectFile) sequentially.
  // Irreversible; gated on a typed window.confirm so a stray click
  // can't destroy a team's library. Doesn't touch local folders —
  // the My-branch sidecar will reconcile each user's view via the
  // existing pruning pass once realtime fires.
  const [wipingMain, setWipingMain] = useState(false);
  const handleWipeMain = useCallback(async () => {
    if (wipingMain || !viewerIsAdmin) return;
    const count = files.length;
    if (count === 0) {
      notify({
        category: 'file',
        variant: 'info',
        title: 'Already empty',
        body: 'The main branch has no files to delete.',
        dedupeKey: 'wipe-main-empty',
      });
      return;
    }
    // eslint-disable-next-line no-alert
    const ok = window.confirm(
      `Permanently delete ALL ${count} file${count === 1 ? '' : 's'} from the main branch?\n\n`
      + 'This affects every member of the project and cannot be undone.',
    );
    if (!ok) return;
    setWipingMain(true);
    let okCount = 0;
    let failCount = 0;
    const wipedIds = new Set();
    for (const f of files) {
      const { error } = await deleteProjectFile({
        id: f.id,
        storagePath: f.storage_path,
        thumbnailPath: f.thumbnail_path,
        thumbnailFrames: f.thumbnail_frames,
      });
      if (error) {
        failCount += 1;
      } else {
        okCount += 1;
        wipedIds.add(f.id);
      }
    }
    setWipingMain(false);
    await refetchCloudFiles();

    // Prune sidecar entries pointing at the wiped cloud rows. Without
    // this, the user's local files on My branch stay mapped to dead
    // cloud ids — and because the sidecar still claims those files are
    // "known", the diff treats them as already-tracked-against-cloud
    // (no action needed) and the My-branch status pill flips to
    // "Synced with main" even though main is now empty. Pruning forces
    // the next reconcile pass to mint fresh UUIDs (Pass 1d), which
    // makes computeBranchDiff emit them as ADDs → "Changes made" pill
    // shows, push re-populates main.
    if (wipedIds.size > 0) {
      setSidecar((prev) => {
        let next = prev;
        for (const id of wipedIds) {
          if (next.byFileId.has(id)) next = removeSidecarEntry(next, id);
        }
        if (next !== prev) saveSidecar(next);
        return next;
      });
    }
    notify({
      category: 'file',
      variant: failCount > 0 ? 'error' : 'success',
      icon: 'trash',
      title: failCount > 0 ? 'Wipe finished with errors' : 'Main branch wiped',
      body: failCount > 0
        ? `${okCount} of ${count} files deleted · ${failCount} failed`
        : `${okCount} file${okCount === 1 ? '' : 's'} deleted from main.`,
      dedupeKey: `wipe-main-result:${Date.now()}`,
    });
  }, [wipingMain, viewerIsAdmin, files, notify, refetchCloudFiles]);

  return (
    <div
      className="project-scoped-page project-files-page"
      ref={pageRef}
      style={{ '--project-files-card-size': `${cardSize}px` }}
    >
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Files</h1>
        <p className="project-scoped-subtitle">
          Drag files anywhere in the window to add them to <strong>{selectedProject.name}</strong>.
        </p>

        {/* Local-folder bar — rendered in Electron + on Chromium-based
            web browsers (where the File System Access API is
            available). On Electron the input is editable (paste a
            path or use Browse); on web it's read-only — the only way
            to bind a folder is the Browse picker, since the browser
            doesn't expose typed paths. */}
        {hasLocalFolderApi && (
          <div className="project-files-local-bar">
            <input
              type="text"
              className="project-files-local-input"
              value={localFolder}
              onChange={(e) => setLocalFolder(e.target.value)}
              placeholder={isElectronBranch
                ? "C:\\Users\\you\\Documents\\project-files"
                : 'Click Browse to pick a folder'}
              readOnly={!isElectronBranch}
              spellCheck={false}
              aria-label="Local download folder"
            />
            {/* Web restore window: handle is loaded but permission
                hasn't been granted yet this session. Show Reconnect
                as the primary action; Browse stays available for
                picking a different folder. */}
            {needsReconnect && (
              <button
                type="button"
                className="project-files-local-btn"
                onClick={handleReconnect}
                title="Grant access to the remembered folder"
              >
                Reconnect
              </button>
            )}
            <button
              type="button"
              className="project-files-local-btn"
              onClick={handleBrowseFolder}
            >
              Browse…
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="project-files-error" role="alert">{error}</div>
      )}

      {/* Tab strip — Main (canonical, read-only) | My branch (private
          working copy, editable). The tabs ARE the branch-view
          selector: clicking flips BranchContext.view. "My branch" is
          hidden for viewers (no editable surface to show) and shows
          a pending-count chip when the member has queued edits. */}
      <div className="project-files-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          id="project-files-tab-main"
          aria-selected={branchView === 'main'}
          aria-controls="project-files-panel"
          className={`project-files-tab${branchView === 'main' ? ' is-active' : ''}`}
          onClick={() => setBranchView('main')}
        >
          {CloudIcon}
          <span>Cloud</span>
        </button>
        {viewerIsMember && (
          <button
            type="button"
            role="tab"
            id="project-files-tab-mine"
            aria-selected={branchView === 'mine'}
            aria-controls="project-files-panel"
            className={`project-files-tab${branchView === 'mine' ? ' is-active' : ''}`}
            onClick={() => setBranchView('mine')}
          >
            {HardDriveIcon}
            <span>Yours</span>
          </button>
        )}
      </div>

      {/* Cloud-tab status row — quiet when there's nothing to do,
          renders the "Waiting for review" pill only when somebody
          has edits awaiting approval, and surfaces the admin's
          destructive "Wipe everything" escape hatch. Hiding the
          empty pill keeps the page calm for first-time / non-tech
          users — every visible element has a real signal. */}
      {(viewerIsMember || viewerIsAdmin) && branchView === 'main' && (openRequestsCount > 0 || viewerIsAdmin) && (
        <div className="project-files-branch-status">
          {openRequestsCount > 0 && (
            <button
              type="button"
              className="project-files-branch-status-item is-interactive is-requests"
              onClick={openVersionControl}
              title="See the edits your team is waiting on"
            >
              <span className="project-files-branch-status-dot" aria-hidden="true" />
              <div className="project-files-branch-status-text">
                <strong className="project-files-branch-status-label">Waiting for review</strong>
                <p className="project-files-branch-status-sub">
                  {`${openRequestsCount} ${openRequestsCount === 1 ? 'person has' : 'people have'} edits waiting for approval.`}
                </p>
              </div>
              <span className="project-files-branch-status-count">{openRequestsCount}</span>
              <span className="project-files-branch-status-cta" aria-hidden="true">Review →</span>
            </button>
          )}
          {viewerIsAdmin && (
            <button
              type="button"
              className="project-files-branch-status-item is-danger is-interactive"
              onClick={handleWipeMain}
              disabled={wipingMain || files.length === 0}
              title={files.length === 0
                ? 'No files to delete'
                : 'Delete every file in the cloud — cannot be undone'}
            >
              <span className="project-files-branch-status-dot" aria-hidden="true" />
              <div className="project-files-branch-status-text">
                <strong className="project-files-branch-status-label">
                  {wipingMain ? 'Deleting…' : 'Wipe everything'}
                </strong>
                <p className="project-files-branch-status-sub">
                  {files.length === 0
                    ? 'Nothing to delete — the cloud is empty.'
                    : `Permanently remove all ${files.length} file${files.length === 1 ? '' : 's'}. Cannot be undone.`}
                </p>
              </div>
              <span className="project-files-branch-status-cta" aria-hidden="true">Delete →</span>
            </button>
          )}
        </div>
      )}

      {/* Branch status — sits between the tab strip and the file grid.
          Four independent signals can light up:
            • "New update on main"  — base_version is behind main_version.
            • "Changes made"        — local edits or queued metadata
                                       changes vs main, not yet pushed.
            • "Awaiting review"     — pushed already, change_request is
                                       still open. Without this signal
                                       the chip falsely falls to
                                       "Synced with main" between push
                                       and admin approval (computeBranchDiff
                                       filters out submitted items, and
                                       main_version hasn't bumped yet).
            • "Synced with main"    — everything else (the calm state).
          Only the active signals are shown. Strictly informational —
          the action lives in the "Revert to main branch" button at
          the bottom of the file grid. */}
      {(viewerIsMember || viewerIsAdmin) && branchView === 'mine' && (() => {
        const hasLocalChanges = branchDiff.length + pendingChanges.length > 0;
        // True the moment the request row is known (rather than
        // when its items finish loading) so the pill doesn't flicker
        // off between "auto-commit pushed" and "items refetched".
        const hasOpenOwnRequest = (changeRequests || []).some(
          (r) => r.author_id === userId && r.status === 'open',
        );
        // "Awaiting review" as a separate pill is gone; the Changes-
        // made pill stays visible while a push is in flight so the
        // user always knows their work is somewhere along the
        // local → review → main pipeline. Synced only fires when
        // there's truly nothing pending.
        const hasUnpushedOrPending = hasLocalChanges || hasOpenOwnRequest;
        const inSync = !isBehindMain && !hasUnpushedOrPending;
        return (
          <div className="project-files-branch-status" role="status" aria-live="polite">
            {isBehindMain && (
              // Interactive when main has moved ahead — clicking opens
              // the sync/revert modal so the user can pull main's
              // bytes down without hunting for the bottom button.
              <button
                type="button"
                className="project-files-branch-status-item is-update is-interactive"
                onClick={() => setSyncModalOpen(true)}
                disabled={!hasLocalFolderApi || !localFolder}
                title={
                  !hasLocalFolderApi || !localFolder
                    ? 'Pick a folder so we can save the new files into it'
                    : 'Download the latest files into your folder'
                }
              >
                <span className="project-files-branch-status-dot" aria-hidden="true" />
                <div className="project-files-branch-status-text">
                  <strong className="project-files-branch-status-label">New files from your team</strong>
                  <p className="project-files-branch-status-sub">
                    {!hasLocalFolderApi || !localFolder
                      ? 'Pick a folder above so we can save the new files there.'
                      : "Someone added or changed files. Click to copy them to your folder."}
                  </p>
                </div>
                <span className="project-files-branch-status-cta" aria-hidden="true">Get them →</span>
              </button>
            )}
            {hasUnpushedOrPending && (() => {
              // Two distinct states share this pill:
              //   • Unsaved local edits → primary action is [Push]
              //     so the user explicitly sends work for review.
              //   • Already pushed, waiting on a reviewer → no
              //     primary action; subtitle becomes "waiting for
              //     review" and the only escape is the "Use cloud
              //     version" link which throws away the pending
              //     request and re-syncs from main.
              const localChangeCount = branchDiff.length + pendingChanges.length;
              const openItemCount = (openOwnRequestItems || []).length;
              const hasLocal = localChangeCount > 0;
              const count = hasLocal ? localChangeCount : openItemCount;
              const label = hasLocal
                ? 'You have unsaved edits'
                : 'Waiting for review';
              const sub = hasLocal
                ? `${count} ${count === 1 ? 'edit' : 'edits'} ready — click Push to send`
                : `${count} ${count === 1 ? 'edit' : 'edits'} sent. Hang tight while your team reviews.`;
              return (
                <span
                  className="project-files-branch-status-item is-changes"
                  role="status"
                  aria-live="polite"
                >
                  <span className="project-files-branch-status-dot" aria-hidden="true" />
                  <div className="project-files-branch-status-text">
                    <strong className="project-files-branch-status-label">{label}</strong>
                    <p className="project-files-branch-status-sub">{sub}</p>
                  </div>
                  <span className="project-files-branch-status-action-group">
                    {hasLocal && (
                      <button
                        type="button"
                        className="project-files-branch-status-action project-files-branch-status-action-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePush();
                        }}
                        disabled={pushing}
                        title="Send your edits for review"
                      >
                        {pushing ? 'Sending…' : 'Push'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="project-files-branch-status-action"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSyncModalOpen(true);
                      }}
                      disabled={!hasLocalFolderApi || !localFolder || pushing}
                      title={!hasLocalFolderApi || !localFolder
                        ? 'Pick a folder above so we can put the cloud version into it'
                        : 'Throw away your edits and use the cloud version instead'}
                    >
                      Discard
                    </button>
                  </span>
                </span>
              );
            })()}
            {inSync && (
              <span className="project-files-branch-status-item is-synced">
                <span className="project-files-branch-status-dot" aria-hidden="true" />
                <div className="project-files-branch-status-text">
                  <strong className="project-files-branch-status-label">Up to date</strong>
                  <p className="project-files-branch-status-sub">
                    Your folder matches the cloud — nothing to send.
                  </p>
                </div>
              </span>
            )}
          </div>
        );
      })()}

      <div
        id="project-files-panel"
        role="tabpanel"
        aria-labelledby={branchView === 'mine' ? 'project-files-tab-mine' : 'project-files-tab-main'}
        className="project-files-panel"
        // Clicking the empty space inside the grid panel clears the
        // current card selection — matches Explorer's "click the
        // background to deselect" affordance. Cards stopPropagation
        // their own clicks so they don't accidentally clear what
        // they just selected.
        onClick={() => setSelectedLocalPath(null)}
      >
        {branchView === 'main' ? (
          // ── Main branch — canonical cloud files. Read-only here;
          // editing happens on My branch (local folder).
          loading ? (
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
                      <FileCard
                        key={f.id}
                        file={f}
                        onOpen={(file) => setOpenFileId(file.id)}
                      />
                    ))}
                  </div>
                </section>
              );
            });
          })()
        ) : (
          // ── My branch — the user's local folder. Members work here:
          // edit a file in its OS app, rename / delete on disk, or
          // click a card whose cloud counterpart exists to edit the
          // metadata via the modal (those edits queue branch_changes).
          // The "modified" pill (size mismatch vs cloud) is the
          // visual diff cue per card.
          !hasLocalFolderApi ? (
            <div className="project-files-empty">
              <h2>Local branch unavailable</h2>
              <p>This build has no filesystem access. Use the desktop app to manage your branch.</p>
            </div>
          ) : !localFolder ? (
            <div className="project-files-empty">
              <h2>Pick a folder</h2>
              <p>Choose a folder on your computer. That folder becomes your workspace — anything you put there gets sent to your team after they approve it.</p>
            </div>
          ) : needsReconnect ? (
            // Web restore: the FileSystemDirectoryHandle is hot-
            // loaded from IndexedDB, but the browser requires a fresh
            // user-gesture permission grant each session. Show the
            // remembered folder name + a primary Reconnect button so
            // the user understands why the grid is empty.
            <div className="project-files-empty">
              <h2>Open "{localFolder}" again</h2>
              <p>Your browser needs you to grant access to this folder each time you visit.</p>
              <button
                type="button"
                className="project-scoped-cta"
                style={{ marginTop: '1rem' }}
                onClick={handleReconnect}
              >
                Open folder
              </button>
            </div>
          ) : localError ? (
            <div className="project-files-error" role="alert">{localError}</div>
          ) : localLoading ? (
            <ProjectFilesGridSkeleton count={null} />
          ) : (
            // Scope toggle + grid. "Local only" hides ghost cards
            // for main-branch files that aren't on disk; "All from
            // main" surfaces them so the user can see what's missing
            // (including files they just deleted locally — those now
            // re-appear as ghosts pulled from the cloud row instead
            // of disappearing entirely).
            <>
              <div className="project-files-scope-toggle" role="tablist" aria-label="What to show">
                <button
                  type="button"
                  role="tab"
                  aria-selected={myBranchScope === 'local'}
                  className={`project-files-scope-btn${myBranchScope === 'local' ? ' is-active' : ''}`}
                  onClick={() => setMyBranchScope('local')}
                >
                  Just mine
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={myBranchScope === 'all'}
                  className={`project-files-scope-btn${myBranchScope === 'all' ? ' is-active' : ''}`}
                  onClick={() => setMyBranchScope('all')}
                >
                  Everything
                </button>
              </div>
              {(() => {
            // Bucket every disk file as a local card, then (when scope
            // == 'all') add ghost "missing" cards for cloud rows that
            // syncState couldn't link to a local file. The unified
            // syncState already classified every fileId; here we just
            // pluck the missing-local entries and surface them with
            // the download overlay.
            const buckets = { photos: [], videos: [], documents: [] };
            const localByLcName = new Map();
            for (const lf of localFiles) {
              if (lf?.name) localByLcName.set(lf.name.toLowerCase(), lf);
            }
            for (const f of localFiles) {
              buckets[categorizeMime(f.mimeType)].push({ kind: 'local', file: f });
            }
            if (myBranchScope === 'all' && syncState) {
              for (const row of syncState.rows.values()) {
                if (row.status !== 'missing-local') continue;
                if (!row.cloud) continue;
                // Bootstrap-window fallback: the sidecar's hash-based
                // reconcile is async, so right after a fresh folder
                // pick / download the user can see "download" cards
                // for files already on disk under the canonical name.
                // Suppress when a local filename matches either the
                // cloud's display name or the storage-path filename
                // (those diverge after an approved rename). The next
                // reconcile pass with hashes wires the sidecar id.
                const cloudLcName = (row.cloud.name || '').toLowerCase();
                if (cloudLcName && localByLcName.has(cloudLcName)) continue;
                const storageFilename = (row.cloud.storage_path || '').split('/').pop()?.toLowerCase();
                if (storageFilename && localByLcName.has(storageFilename)) continue;
                buckets[categorizeMime(row.cloud.mime_type)].push({
                  kind: 'missing',
                  file: row.cloud,
                });
              }
            }
            const totalItems = buckets.photos.length + buckets.videos.length + buckets.documents.length;
            if (totalItems === 0) {
              // Empty grid — either truly nothing (no local, no
              // cloud) or "local only" scope with empty folder. Show
              // the sync-with-main prompt when there's cloud content
              // to pull; otherwise the generic empty-project nudge.
              return (
                <div className="project-files-empty">
                  <h2>Folder is empty</h2>
                  {files.length > 0 ? (
                    <>
                      <p>
                        {myBranchScope === 'local'
                          ? `Switch to "Everything" to see the ${files.length} file${files.length === 1 ? '' : 's'} in the cloud, or download them.`
                          : `Download ${files.length} file${files.length === 1 ? '' : 's'} from the cloud into this folder to start working.`}
                      </p>
                      <button
                        type="button"
                        className="project-scoped-cta"
                        style={{ marginTop: '1rem' }}
                        onClick={() => setSyncModalOpen(true)}
                      >
                        Get latest
                      </button>
                    </>
                  ) : !loading ? (
                    <p>This project has no files yet. Use the + button to add your first one.</p>
                  ) : null}
                </div>
              );
            }
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
                    {items.map((entry) => {
                      if (entry.kind === 'missing') {
                        return (
                          <FileCard
                            key={`missing-${entry.file.id}`}
                            file={entry.file}
                            onOpen={(file) => handleDownloadOne(file)}
                            branchOverlay={{ kind: 'missing' }}
                          />
                        );
                      }
                      const f = entry.file;
                      const lcName = (f.name || '').toLowerCase();
                      // Sidecar-driven cloud resolution: filename →
                      // fileId → cloud. One hop. The legacy
                      // filename / display-name / proposed-name /
                      // hash fallback stack is gone — the sidecar's
                      // reconciliation pass absorbs all of those
                      // cases (rename / replace / bootstrap) into a
                      // single stable id mapping. A null cloud here
                      // means "local-only file not yet pushed".
                      const fileId = sidecar.byFilename.get(lcName);
                      const cloud = fileId ? cloudById.get(fileId) : null;
                      // Derive the "Modified" pill from branchDiff
                      // directly so the per-card signal mirrors the
                      // status chip exactly — same filter (open-
                      // request items hidden, soft-hold applied),
                      // same source of truth. The old per-card
                      // bytesDiffer recomputed independently and
                      // stayed lit after a push because it didn't
                      // know about the open-request filter.
                      const bytesDiffer = Boolean(cloud) && diffReplaceCloudIds.has(cloud.id);
                      // True only when the local file's BYTES diverge
                      // from cloud (rename-only divergence excluded).
                      // Tells LocalFileCard the cloud-baked thumbnail
                      // is stale and to fall back to a freshly
                      // regenerated local thumbnail instead.
                      const bytesChanged = Boolean(cloud) && bytesDifferCloudIds.has(cloud.id);
                      // Queued metadata edit (rename / description)
                      // — fires only on un-pushed pendingChanges
                      // (overlayByFileId is built from those). After
                      // a push, pendingChanges is cleared so the
                      // overlay is gone; the EDITED corner pill
                      // disappears too, which matches the "the file
                      // is now in a request, not in your working
                      // copy" mental model.
                      const overlay = cloud ? overlayByFileId.get(cloud.id) : null;
                      const hasPendingMeta = Boolean(overlay);
                      const isModified = bytesDiffer || hasPendingMeta;
                      return (
                        <LocalFileCard
                          key={f.path}
                          file={f}
                          onSelect={handleSelectLocalCard}
                          onOpen={handleOpenLocalCard}
                          onDoubleOpen={handleOpenLocalFile}
                          onRename={handleRenameLocalCard}
                          onRenameSubmit={handleRenameSubmit}
                          onRenameCancel={handleRenameCancel}
                          onRevert={handleRevertLocalCard}
                          onDelete={handleDeleteLocalCard}
                          selected={selectedLocalPath === f.path}
                          isRenaming={renamingPath === f.path}
                          modified={isModified}
                          bytesChanged={bytesChanged}
                          cloud={cloud}
                          overlay={overlay}
                          localContentHash={localHashByName.get(f.name) || null}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            });
          })()}
            </>
          )
        )}

        {/* "Revert to main branch" — the single destructive action
            that pulls main's bytes into the local folder AND discards
            every queued change. SyncToMainModal shows the diff first
            so the user can back out before applying. Disabled in the
            calm state (nothing queued, already in sync). Sits at
            the bottom of the My branch grid so users scanning for
            "how do I throw this all away?" find it predictably. */}
        {branchView === 'mine' && (viewerIsMember || viewerIsAdmin) && hasLocalFolderApi && localFolder && (
          <div className="project-files-revert-row">
            <button
              type="button"
              className="project-files-revert-btn"
              onClick={() => setSyncModalOpen(true)}
              disabled={
                !isBehindMain
                && (branchDiff.length + pendingChanges.length) === 0
              }
            >
              Discard my edits, use cloud version
            </button>
          </div>
        )}
      </div>

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
      {openFileId && (() => {
        const openCloudRow = files.find((f) => f.id === openFileId) || null;
        // On My branch, when the local bytes diverge from the cloud
        // version (queued replace / in-place edit), the cloud
        // thumbnail + signed preview URL both point at the stale
        // pre-edit bytes. The card already regenerates its thumbnail
        // from disk in that case; route the modal through the same
        // local-bytes path so the preview pane matches what the card
        // is showing instead of paint the old version.
        const wantLocalOverride = (
          branchView === 'mine'
          && openCloudRow
          && bytesDifferCloudIds.has(openCloudRow.id)
        );
        let localPathForPreview = null;
        let localMtimeForPreview = null;
        let localHashForPreview = null;
        if (wantLocalOverride) {
          const sidecarEntry = sidecar.byFileId.get(openCloudRow.id);
          const trackedFilename = sidecarEntry?.filename
            || (openCloudRow.storage_path || '').split('/').pop();
          if (trackedFilename) {
            const lcTracked = trackedFilename.toLowerCase();
            const localMatch = localFiles.find(
              (f) => (f.name || '').toLowerCase() === lcTracked,
            );
            if (localMatch?.path) {
              localPathForPreview = localMatch.path;
              localMtimeForPreview = localMatch.mtimeIso || null;
              localHashForPreview = localHashByName.get(trackedFilename) || null;
            }
          }
        }
        const handleModalLocalRename = async (newName) => {
          // Rename the on-disk file that corresponds to the cloud
          // file the modal is editing. Only fires on My branch
          // with a folder bound; no-op otherwise.
          if (!hasLocalFolderApi || !localFolder) return;
          if (!openCloudRow) return;
          // Sidecar lookup is the source of truth — find the
          // local filename currently mapped to this cloud row's
          // id. Falls back to the storage filename for the
          // brief bootstrap window before the sidecar has caught
          // up (e.g., a brand-new download on the first ever
          // render before the reconcile pass ran).
          const sidecarEntry = sidecar.byFileId.get(openCloudRow.id);
          const trackedFilename = sidecarEntry?.filename
            || (openCloudRow.storage_path || '').split('/').pop();
          if (!trackedFilename) return;
          const lcTracked = trackedFilename.toLowerCase();
          const localMatch = localFiles.find(
            (f) => (f.name || '').toLowerCase() === lcTracked,
          );
          if (!localMatch) return;
          // Preserve the disk-side extension. The cloud's display
          // name might be raw ("bar") — append the disk extension
          // so the renamed file still opens with the right app.
          const fromName = localMatch.name;
          const lastDot = fromName.lastIndexOf('.');
          const ext = lastDot > 0 ? fromName.slice(lastDot + 1) : '';
          let toName = (newName || '').trim();
          if (!toName) return;
          if (ext && !toName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
            toName = `${toName}.${ext}`;
          }
          if (fromName === toName) return;
          const { error } = await localFolderApi.renameFile({
            dir: localFolder,
            fromName,
            toName,
          });
          if (error) return;
          // Sidecar follows the rename — keep the same fileId,
          // swap the filename. Done synchronously so the matching
          // is correct in the very next render rather than
          // waiting on the reconciliation pass to hash-detect it.
          setSidecar((prev) => {
            const next = renameSidecarEntry(prev, fromName, toName);
            if (next !== prev) saveSidecar(next);
            return next;
          });
          // Refresh the local listing so the renamed file appears
          // immediately instead of waiting on the watcher poll.
          const { files: localList, error: listErr } = await localFolderApi.list(localFolder);
          if (!listErr) setLocalFiles(localList || []);
        };
        const sharedProps = {
          file: openCloudRow,
          onClose: () => setOpenFileId(null),
          onDeleted: (id) => setFiles((prev) => prev.filter((f) => f.id !== id)),
          readOnly: branchView === 'main',
          onLocalRename: handleModalLocalRename,
        };
        return localPathForPreview
          ? (
            <MyBranchEditedFileDetail
              {...sharedProps}
              localPath={localPathForPreview}
              localMtime={localMtimeForPreview}
              localContentHash={localHashForPreview}
            />
          )
          : <FileDetailModal {...sharedProps} />;
      })()}

      {/* Local-only inspector — opens when the user clicks a My-branch
          card whose file has no cloud counterpart yet (not pushed).
          Wrapper resolves the local preview URL (localfile:// on
          Electron, blob: from the cached FSA handle on web) and
          hands it to FileDetailModal as a previewUrlOverride so the
          modal renders the on-disk bytes — image / video / PDF /
          text — without needing a Supabase storage_path. readOnly
          suppresses rename / delete; the FAB / commit flow is the
          right edit surface for an un-pushed file. */}
      {openLocalOnlyFile && (
        <LocalOnlyFileDetail
          localFile={openLocalOnlyFile}
          projectId={projectId}
          viewerId={userId}
          onClose={() => setOpenLocalOnlyFile(null)}
        />
      )}

      {/* Branch flow modals — Revert only (pull main into local +
          discard queued changes). Commit is gone: every local edit
          auto-pushes via the runCommitFlow effect above, so the
          user never opens a manual commit modal. The .jsx is kept
          on disk in case a manual path is needed later. */}
      <SyncToMainModal
        open={syncModalOpen}
        onClose={() => setSyncModalOpen(false)}
        snapshot={syncState?.toSync || []}
        localFolder={localFolder}
        onSyncComplete={({ syncedHashes, deletedNames, syncedFileIds }) => {
          // Sync just made the local folder byte-identical to main
          // for every synced file. Prime the hash map with the known
          // cloud hashes so the "Modified" pill clears in this render
          // — without waiting on the background re-hash effect.
          setLocalHashByName((prev) => {
            const next = new Map(prev);
            for (const [name, hash] of syncedHashes) next.set(name, hash);
            for (const name of deletedNames) next.delete(name);
            return next;
          });
          // Update sidecar: claim cloud.id for each downloaded file,
          // drop entries for files just deleted locally. Without this
          // the reconciliation effect would re-establish the mapping
          // on the next pass — but only after the disk listing
          // refreshes AND hashes catch up, leaving a window where
          // freshly-synced files render as orphans.
          setSidecar((prev) => {
            let next = prev;
            for (const [filename, fileId] of syncedFileIds || new Map()) {
              const hash = syncedHashes.get(filename) || null;
              next = addSidecarEntry(next, fileId, {
                filename,
                contentHash: hash,
                mtime: new Date().toISOString(),
              });
            }
            for (const name of deletedNames || new Set()) {
              const fid = next.byFilename.get(name);
              if (fid) {
                next.byFileId.delete(fid);
                next.byFilename.delete(name);
                // Need a fresh reference for React to detect the change.
                next = {
                  projectId: next.projectId,
                  localFolder: next.localFolder,
                  byFileId: new Map(next.byFileId),
                  byFilename: new Map(next.byFilename),
                };
              }
            }
            if (next !== prev) saveSidecar(next);
            return next;
          });
        }}
        onLocalListChanged={async () => {
          // Refresh the local listing after the sync so the
          // newly-downloaded files appear and the deleted ones
          // disappear without waiting for the watcher's poll.
          if (!hasLocalFolderApi || !localFolder) return;
          const { files: localList, error: listErr } = await localFolderApi.list(localFolder);
          if (!listErr) setLocalFiles(localList || []);
        }}
      />

      {/* Floating action button — bottom-right of the viewport. Only
          shown on 'mine' branch (Main is read-only; adding files
          belongs to the user's local working copy). Clicking opens an
          OS file picker; selected files are written directly to the
          chosen local folder and appear in the grid via the next
          list refresh. They live locally until the user pushes via
          the Changes-made pill — no cloud round-trip on add. */}
      {branchView === 'mine' && (viewerIsMember || viewerIsAdmin) && hasLocalFolderApi && (
        <>
          <input
            ref={localUploadInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleLocalFilesPicked}
          />
          <button
            type="button"
            className="project-files-fab"
            onClick={() => {
              if (!localFolder) {
                notify({
                  category: 'file',
                  variant: 'error',
                  title: 'Pick a folder first',
                  body: 'Use Browse… above to choose where your branch lives.',
                  dedupeKey: 'fab-no-folder',
                });
                return;
              }
              localUploadInputRef.current?.click();
            }}
            aria-label="Add files to your branch"
            disabled={!localFolder}
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
        </>
      )}
    </div>
  );
}
