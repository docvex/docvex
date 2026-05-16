import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useBranch } from '../../context/BranchContext';
import { useAuth } from '../../context/AuthContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import FileDetailModal from '../../components/FileDetailModal';
import ChangeRequestsPanel from '../../components/ChangeRequestsPanel';
import SyncToMainModal from '../../components/SyncToMainModal';
import CommitChangesModal from '../../components/CommitChangesModal';
import FileThumbnail from '../../components/FileThumbnail';
import Tooltip from '../../components/Tooltip';
import {
  listProjectFiles,
  createSignedDownloadUrl,
  subscribeForProject,
} from '../../lib/projectFiles';
import { computeBranchDiff, sha256Hex } from '../../lib/branches';
import {
  localFolderApi,
  hasLocalFolderApi,
  isElectronBranch,
  readLocalBlob,
} from '../../lib/localFolder';
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
        <FileThumbnail
          mimeType={file.mime_type}
          posterUrl={thumbUrl}
          slideshowFrames={file.thumbnail_frames}
          hovered={hovered}
          glyph={iconForMime(file.mime_type)}
          duration={file.duration_seconds}
        />
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
function LocalFileCard({ file, onOpen, modified, cloud, overlay }) {
  const { base: diskBase, ext } = splitNameAndExtension(file.name);
  // Effective display name precedence:
  //   1. overlay.proposed.name  — queued rename on 'mine'. The card
  //      must mirror what FileDetailModal shows AND what main will
  //      look like after approval; without this it'd revert to the
  //      old cloud.name even though the user just renamed it.
  //   2. cloud.name             — canonical main-branch name.
  //   3. diskBase               — the on-disk basename (fallback for
  //      local files that have no cloud counterpart).
  const proposedName = overlay?.proposed?.name;
  const sourceName = proposedName || cloud?.name || null;
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
  // URL used as the src for image previews + the hidden <video>
  // that generates video thumbnails.
  //   • Electron path → custom `localfile://` protocol (registered
  //     in main.js, streams the bytes off disk).
  //   • Web path     → blob: URL built from the FileSystemFileHandle
  //     cached in lib/localFolder.js. Built lazily in an effect
  //     because getFile() is async; revoked on unmount/path change.
  // Either way the rest of the card just consumes a string src.
  const isImage = (file.mimeType || '').startsWith('image/');
  const isVideo = (file.mimeType || '').startsWith('video/');
  const isWebPath = typeof file.path === 'string' && file.path.startsWith('web://');
  // Web path: getFile() is async, so build the blob URL in an effect.
  // Electron path: localfile:// is synchronous from the URL's POV; build
  // it inline. Revoke the blob URL on cleanup so deleted/replaced files
  // don't leak memory.
  const [webBlobUrl, setWebBlobUrl] = useState(null);
  useEffect(() => {
    if (!isWebPath || (!isImage && !isVideo)) return undefined;
    let cancelled = false;
    let url = null;
    readLocalBlob(file.path).then((blob) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setWebBlobUrl(url);
    }).catch(() => { /* missing handle — fall back to glyph */ });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setWebBlobUrl(null);
    };
  }, [isWebPath, isImage, isVideo, file.path]);
  const localUrl = isWebPath
    ? webBlobUrl
    : (file.path ? `localfile://local/${encodeURIComponent(file.path)}` : null);

  // Cloud counterpart's pre-baked thumbnail (signed). When a local file
  // pairs with a cloud row that has thumbnail_path (post-migration 004),
  // using the cloud thumb here keeps the Main and My-branch grid views
  // visually identical — same poster, same dimensions, no second
  // "regenerated locally" version. Falls through to localUrl-based
  // extraction (handled inside FileThumbnail) when there's no cloud
  // counterpart or the cloud has no thumb.
  const [cloudThumbUrl, setCloudThumbUrl] = useState(null);
  useEffect(() => {
    const path = cloud?.thumbnail_path;
    if (!path) { setCloudThumbUrl(null); return undefined; }
    let cancelled = false;
    createSignedDownloadUrl(path, 600).then(({ data, error }) => {
      if (cancelled || error || !data?.signedUrl) return;
      setCloudThumbUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [cloud?.thumbnail_path]);
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

  const handleMenuOpen = () => {
    closeMenu();
    onOpen?.(file);
  };
  const handleMenuShowInFolder = () => {
    closeMenu();
    if (file?.path) localFolderApi.showInFolder(file.path);
  };

  return (
    <div
      className="project-files-local-card-wrap"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        className="project-files-card"
        onClick={() => onOpen?.(file)}
      >
        <div className="project-files-thumb">
          <FileThumbnail
            mimeType={file.mimeType}
            posterUrl={cloudThumbUrl}
            sourceUrl={localUrl}
            glyph={iconForMime(file.mimeType)}
            duration={cloud?.duration_seconds}
          />
        </div>
        {ext && (
          <span className="project-files-ext" aria-hidden="true">
            {ext.toUpperCase()}
          </span>
        )}
        <div className="project-files-meta">
          <div className="project-files-name">{base || file.name}</div>
          <div className="project-files-sub">
            {formatBytes(displaySize)} · {formatDate(displayDate)}
          </div>
        </div>
      </button>
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
                  onClick={handleMenuOpen}
                >
                  Open
                </button>
              </li>
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
  } = useBranch();
  // Modals: revert-to-main (SyncToMainModal — pulls main into local
  // AND discards queued changes; wired to the "Revert to main branch"
  // button + the "New update on main" status chip), commit-changes
  // (push current local branch state for review; wired to the
  // "Changes made" status chip), and the admin review panel.
  const [requestsPanelOpen, setRequestsPanelOpen] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const openRequestsCount = useMemo(
    () => changeRequests.filter((r) => r.status === 'open').length,
    [changeRequests],
  );

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

  // Diff between the user's local branch folder and the canonical
  // cloud list — drives the Commit-changes button count + the
  // commit modal's item preview. computeBranchDiff is pure and
  // accepts the optional hash maps; comparison falls back to size
  // when either side lacks a hash. The open-request items get
  // passed in too so any change already submitted (and awaiting
  // admin review) is excluded — the Commit button hides as soon as
  // a push lands instead of staying lit forever.
  const branchDiff = useMemo(
    () => (branchView === 'mine'
      ? computeBranchDiff(localFiles, files, localHashByName, cloudHashByFileId, openOwnRequestItems)
      : []),
    [branchView, localFiles, files, localHashByName, cloudHashByFileId, openOwnRequestItems],
  );
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
    // Only the Electron backend has persistent paths — the web's
    // File System Access API hands back an opaque handle each
    // session and re-grants permission via a user gesture, so a
    // saved name from a previous session would just be misleading.
    let cached = '';
    if (isElectronBranch) {
      try {
        cached = localStorage.getItem(LOCAL_FOLDER_KEY(projectId)) || '';
      } catch { /* private-mode etc. — fall through with empty */ }
    }
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
  // user changed something. Memoised on `files` so the click handler
  // below can hold a stable reference for the My-branch → cloud-file
  // lookup without redoing the loop on every render.
  const cloudByFilename = useMemo(() => {
    const map = new Map();
    for (const f of files) {
      const filename = (f.storage_path || '').split('/').pop();
      if (filename) map.set(filename.toLowerCase(), f);
    }
    return map;
  }, [files]);

  // Click handler for cards on the My-branch (local) tab. Match the
  // local file to a cloud row in priority:
  //   1. Filename match (normal case).
  //   2. Queued-rename overlay (proposed.name == local name) — keeps
  //      the modal openable on a freshly-renamed file before/after
  //      the disk rename catches up.
  //   3. Hash match — last-resort for local files renamed outside
  //      the app.
  // No match → opens in the OS default app (no cloud metadata to edit).
  const handleOpenLocalCard = useCallback((localFile) => {
    const lcName = (localFile.name || '').toLowerCase();
    let cloud = cloudByFilename.get(lcName);
    // Post-approval display-name match — cloud.name reflects the
    // merged rename even though storage_path keeps the original
    // filename. Same priority as the page render to stay consistent.
    if (!cloud) {
      cloud = files.find((f) => (f.name || '').toLowerCase() === lcName) || null;
    }
    if (!cloud) {
      const renameChange = pendingChanges.find(
        (c) => c.proposed?.name && c.target_file_id
          && c.proposed.name.toLowerCase() === lcName,
      );
      if (renameChange) {
        cloud = files.find((f) => f.id === renameChange.target_file_id) || null;
      }
    }
    if (!cloud) {
      const localHash = localHashByName.get(lcName);
      if (localHash) {
        cloud = files.find(
          (f) => (f.content_hash || cloudHashByFileId.get(f.id)) === localHash,
        ) || null;
      }
    }
    if (cloud) setOpenFileId(cloud.id);
    else handleOpenLocalFile(localFile);
  }, [cloudByFilename, files, pendingChanges, localHashByName, cloudHashByFileId, handleOpenLocalFile]);

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
          <span>Main</span>
          <span className="project-files-tab-count">{files.length}</span>
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
            <span>My branch</span>
            {pendingChanges.length > 0 && (
              <span className="project-files-tab-count">{pendingChanges.length}</span>
            )}
          </button>
        )}
      </div>

      {/* Main-tab pill row — currently just the "Change requests"
          pill, which lets any member/admin open the review panel.
          Same .project-files-branch-status container as the My-branch
          status row below so both rows share spacing and pill styles. */}
      {(viewerIsMember || viewerIsAdmin) && branchView === 'main' && (
        <div className="project-files-branch-status">
          <button
            type="button"
            className="project-files-branch-status-item is-requests is-interactive"
            onClick={() => setRequestsPanelOpen(true)}
            title="Open the change-requests review panel"
          >
            <span className="project-files-branch-status-dot" aria-hidden="true" />
            <span className="project-files-branch-status-label">Change requests</span>
            {openRequestsCount > 0 && (
              <span className="project-files-branch-status-count">{openRequestsCount}</span>
            )}
            <span className="project-files-branch-status-cta" aria-hidden="true">Open →</span>
          </button>
        </div>
      )}

      {/* Branch status — sits between the tab strip and the file grid.
          Three independent signals can light up:
            • "New update on main"  — base_version is behind main_version.
            • "Changes made"        — local edits or queued metadata
                                       changes vs main.
            • "Synced with main"    — everything else (the calm state).
          Only the active signals are shown. Strictly informational —
          the action lives in the "Revert to main branch" button at
          the bottom of the file grid. */}
      {(viewerIsMember || viewerIsAdmin) && branchView === 'mine' && (() => {
        const hasLocalChanges = branchDiff.length + pendingChanges.length > 0;
        const inSync = !isBehindMain && !hasLocalChanges;
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
                    ? 'Pick a local folder to sync into'
                    : 'Sync your branch with main'
                }
              >
                <span className="project-files-branch-status-dot" aria-hidden="true" />
                <span className="project-files-branch-status-label">New update on main</span>
                <span className="project-files-branch-status-cta" aria-hidden="true">Sync →</span>
              </button>
            )}
            {hasLocalChanges && (
              // Interactive when local changes exist — clicking opens
              // the commit modal so the user can push their branch
              // for admin review without scrolling to find an action.
              <button
                type="button"
                className="project-files-branch-status-item is-changes is-interactive"
                onClick={() => setCommitModalOpen(true)}
                title="Push these changes for review"
              >
                <span className="project-files-branch-status-dot" aria-hidden="true" />
                <span className="project-files-branch-status-label">Changes made</span>
                <span className="project-files-branch-status-cta" aria-hidden="true">Push →</span>
              </button>
            )}
            {inSync && (
              <span className="project-files-branch-status-item is-synced">
                <span className="project-files-branch-status-dot" aria-hidden="true" />
                <span className="project-files-branch-status-label">Synced with main</span>
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
              <h2>No folder chosen</h2>
              <p>Pick a folder above — that becomes your branch. The files there are what you'll commit when you push for review.</p>
            </div>
          ) : localError ? (
            <div className="project-files-error" role="alert">{localError}</div>
          ) : localLoading ? (
            <ProjectFilesGridSkeleton count={null} />
          ) : localFiles.length === 0 ? (
            <div className="project-files-empty">
              <h2>Folder is empty</h2>
              <p>Click <strong>Download</strong> above to copy main's files into your branch, then edit them locally.</p>
            </div>
          ) : (() => {
            // Bucket BOTH local files AND cloud files that aren't yet
            // on disk. Local cards get the "modified" pill when their
            // bytes differ from cloud; missing-from-disk cloud cards
            // get the download-cloud overlay so the user can pull
            // them down individually without running the full batch
            // Download in the header bar.
            const localByName = new Map(
              localFiles.map((f) => [(f.name || '').toLowerCase(), f]),
            );
            // Hash-fallback index for cloud rows — used to re-link a
            // local file to its cloud counterpart when the on-disk
            // filename no longer matches (e.g. after the user renamed
            // via the FileDetailModal, which renames the disk file
            // too but leaves cloud.storage_path's filename alone).
            const cloudByHash = new Map();
            for (const cf of files) {
              const h = cf.content_hash || cloudHashByFileId.get(cf.id);
              if (h) cloudByHash.set(h, cf);
            }
            // Overlay-based re-linking — the authoritative pair for
            // any queued rename. As soon as the user renames in the
            // modal, the optimistic branch_changes row carries
            // proposed.name; that's deterministic and arrives instantly,
            // so we don't have to wait on the async hash computation
            // to recognize that the on-disk "bar.png" is the same file
            // as cloud's storage_path "foo.png". Survives reload too
            // because branch_changes is server-persisted.
            //
            // Map: lowercase proposed name → cloud row.
            const cloudByProposedName = new Map();
            for (const change of pendingChanges) {
              if (!change.target_file_id) continue;
              const proposedName = change.proposed?.name;
              if (!proposedName) continue;
              const cf = files.find((c) => c.id === change.target_file_id);
              if (cf) cloudByProposedName.set(proposedName.toLowerCase(), cf);
            }
            // Display-name index — after a rename gets approved,
            // cloud.name carries the new value but cloud.storage_path
            // still ends with the ORIGINAL filename (renames are
            // metadata-only on the storage side). Without this index,
            // a refresh post-approval would see a local "bar.png" and
            // a cloud whose storage_path ends in "foo.png", treat
            // them as unrelated, and render the cloud row as a
            // "missing" card — duplicating the file the user already
            // has. Indexing by cloud.name closes that gap
            // immediately, without waiting on async hash backfill.
            const cloudByDisplayName = new Map();
            for (const cf of files) {
              if (cf.name) cloudByDisplayName.set(cf.name.toLowerCase(), cf);
            }
            const buckets = { photos: [], videos: [], documents: [] };
            for (const f of localFiles) {
              buckets[categorizeMime(f.mimeType)].push({ kind: 'local', file: f });
            }
            for (const cloud of files) {
              const filename = (cloud.storage_path || '').split('/').pop()?.toLowerCase();
              if (!filename) continue;
              if (localByName.has(filename)) continue;
              // Display-name fallback: post-approval, cloud.name is
              // the renamed value while storage_path still ends with
              // the original filename. If local has the new name on
              // disk, this cloud is its counterpart.
              const displayLc = (cloud.name || '').toLowerCase();
              if (displayLc && localByName.has(displayLc)) continue;
              // Overlay-fallback: if a pending edit's proposed.name
              // exists on disk, the cloud row IS that local file's
              // counterpart — don't show it as missing.
              const overlay = overlayByFileId.get(cloud.id);
              const proposedLc = overlay?.proposed?.name?.toLowerCase();
              if (proposedLc && localByName.has(proposedLc)) continue;
              // Hash-fallback: if the cloud row has a content_hash
              // that matches some local file's hash, the local file
              // IS its counterpart (just under a different filename
              // post-rename). Don't show it as missing.
              const h = cloud.content_hash || cloudHashByFileId.get(cloud.id);
              if (h) {
                const linked = localFiles.some(
                  (lf) => localHashByName.get((lf.name || '').toLowerCase()) === h,
                );
                if (linked) continue;
              }
              buckets[categorizeMime(cloud.mime_type)].push({ kind: 'missing', file: cloud });
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
                      // Resolve the cloud counterpart in priority:
                      //   1. Storage filename match (no rename in flight).
                      //   2. Cloud display-name match — post-approval,
                      //      cloud.name has the new name even though
                      //      storage_path still ends with the old one.
                      //      Without this, a refresh after a merged
                      //      rename would show the cloud row as a
                      //      separate "missing" card next to the
                      //      local file the user already has.
                      //   3. Overlay proposed.name match — same idea,
                      //      but BEFORE approval (the branch_change
                      //      row is still in place).
                      //   4. Hash fallback — non-rename paths or
                      //      legacy rows without a branch_change.
                      let cloud = cloudByFilename.get(lcName);
                      if (!cloud) cloud = cloudByDisplayName.get(lcName);
                      if (!cloud) cloud = cloudByProposedName.get(lcName);
                      const localHash = localHashByName.get(lcName);
                      if (!cloud && localHash) {
                        cloud = cloudByHash.get(localHash);
                      }
                      // Hash-first detection: if BOTH sides have a
                      // content_hash, that's the authoritative answer
                      // (catches same-size content edits). The cloud
                      // hash falls back to the lazily-populated
                      // backfill cache for legacy rows. Otherwise the
                      // size mismatch heuristic.
                      const cloudHash = cloud?.content_hash || (cloud ? cloudHashByFileId.get(cloud.id) : null);
                      const bytesDiffer = Boolean(cloud) && (
                        (localHash && cloudHash)
                          ? localHash !== cloudHash
                          : Number(cloud.size_bytes) !== Number(f.sizeBytes)
                      );
                      // The pill also fires when there's a queued
                      // metadata edit (rename / description / etc.)
                      // against this file's cloud row — that's a real
                      // un-pushed change even if the bytes haven't
                      // moved. The on-disk rename path only updates
                      // the filename, so without this branch a rename-
                      // only commit would have no visual cue on the card.
                      const overlay = cloud ? overlayByFileId.get(cloud.id) : null;
                      const hasPendingMeta = Boolean(overlay);
                      const isModified = bytesDiffer || hasPendingMeta;
                      return (
                        <LocalFileCard
                          key={f.path}
                          file={f}
                          onOpen={handleOpenLocalCard}
                          modified={isModified}
                          cloud={cloud}
                          overlay={overlay}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            });
          })()
        )}

        {/* Revert to main branch — sits below the file grid on My
            branch. Single destructive action that replaces the old
            Sync / Reset / Commit trio: discards every queued change
            and pulls main's bytes down so the local folder matches
            main exactly. The modal (SyncToMainModal) shows the diff
            first so the user can back out before applying. Disabled
            in the calm state (nothing to revert + already in sync). */}
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
              Revert to main branch
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
      {openFileId && (
        <FileDetailModal
          file={files.find((f) => f.id === openFileId) || null}
          onClose={() => setOpenFileId(null)}
          onDeleted={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
          readOnly={branchView === 'main'}
          onLocalRename={async (newName) => {
            // Rename the on-disk file that corresponds to the cloud
            // file the modal is editing. Only fires on My branch
            // with a folder bound; no-op otherwise.
            if (!hasLocalFolderApi || !localFolder) return;
            const openCloud = files.find((f) => f.id === openFileId);
            if (!openCloud) return;
            const originalFilename = (openCloud.storage_path || '').split('/').pop();
            if (!originalFilename) return;
            // Find the local file: by name first, then by hash for
            // the case where it was renamed locally already.
            const lcOriginal = originalFilename.toLowerCase();
            let localMatch = localFiles.find((f) => (f.name || '').toLowerCase() === lcOriginal);
            if (!localMatch) {
              const cloudHash = openCloud.content_hash || cloudHashByFileId.get(openCloud.id);
              if (cloudHash) {
                localMatch = localFiles.find((f) =>
                  localHashByName.get((f.name || '').toLowerCase()) === cloudHash,
                );
              }
            }
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
            // Refresh the local listing so the renamed file appears
            // immediately instead of waiting on the watcher poll.
            const { files: localList, error: listErr } = await localFolderApi.list(localFolder);
            if (!listErr) setLocalFiles(localList || []);
          }}
        />
      )}

      {/* Branch flow modals — Commit (push for review) and Revert
          (pull main into local + discard queued changes). Each gated
          on its own open-state so they share no z-index with
          FileDetailModal. */}
      <CommitChangesModal
        open={commitModalOpen}
        onClose={() => setCommitModalOpen(false)}
        localFiles={localFiles}
        cloudFiles={files}
        pendingChanges={pendingChanges}
      />
      <SyncToMainModal
        open={syncModalOpen}
        onClose={() => setSyncModalOpen(false)}
        localFiles={localFiles}
        cloudFiles={files}
        localFolder={localFolder}
        localHashByName={localHashByName}
        cloudHashByFileId={cloudHashByFileId}
        onSyncComplete={({ syncedHashes, deletedNames }) => {
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
      <ChangeRequestsPanel
        open={requestsPanelOpen}
        onClose={() => setRequestsPanelOpen(false)}
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
