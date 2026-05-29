import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useBranch } from '../../context/BranchContext';
import { useAuth } from '../../context/AuthContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import SyncToMainModal from '../../components/SyncToMainModal';
import FilesWorkspace from '../../components/FilesWorkspace';
import { openDocxInWindow } from '../../lib/openDocxWindow';
import { runCommitFlow, buildCommitSnapshot } from '../../lib/commitFlow';
import FileThumbnail from '../../components/FileThumbnail';
import Tooltip from '../../components/Tooltip';
import { useMorphPill } from '../../components/useMorphPill';
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
import { openFileWindow, openDocx, canOpenInApp, isDocxFile } from '../../lib/platform';
import {
  loadSidecar,
  saveSidecar,
  emptySidecar,
  addEntry as addSidecarEntry,
  removeByFilename as removeSidecarByFilename,
  removeEntry as removeSidecarEntry,
  LEGACY_SIDECAR_KEY,
  toPayload as sidecarToPayload,
} from '../../lib/localBranchMeta';
import { loadHiddenFiles, saveHiddenFiles } from '../../lib/hiddenFiles';
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

// Drag-and-drop payload type for moving a local file into a folder.
// A custom MIME so our drop targets only react to in-app file drags
// (not arbitrary OS drags or text selections).
const MOVE_DND_TYPE = 'application/x-docvex-localpath';

// Folder glyphs for the "Folders" category. Inline per the project's
// no-icon-library convention; currentColor so they inherit hover/active.
// Two states: OUTLINE for an empty folder, FILLED for one with contents.
const FolderGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
const FolderGlyphFilled = (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
// Pick the glyph for a folder: filled when it has contents, outline when
// empty. `empty === undefined` (e.g. cloud folders, always non-empty by
// derivation) falls back to filled.
const folderGlyphFor = (empty) => (empty ? FolderGlyph : FolderGlyphFilled);

// Shortcut overlay — marks a card in the "Waiting for review" section as
// an alias of a file that also lives in its category section (an up-right
// arrow, the classic OS shortcut affordance).
const ShortcutGlyph = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 7h9v9" />
    <path d="M17 7 7 17" />
  </svg>
);

// Chevron — collapse/expand affordance on the unsaved-edits chip. Points
// down when collapsed; rotated 180° via CSS when the file list is open.
const ChevronDownIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

// Classify a local file's pending change into one of three buckets for the
// color-coded corner dot + its tooltip, or null when the file is in sync
// (no dot). Reads the unified syncState row, which still reflects the
// local-vs-cloud diff while a change sits in an open request (cloud isn't
// updated until approval):
//   • local-only          → Added   (new file, no cloud row yet)
//   • replace             → Edited  (contents changed)
//   • rename + folderDiffers → Moved (relocated to another folder)
//   • rename (name only)  → Edited  (renamed)
//   • synced / missing / orphan → null (no dot)
function describeChange(row) {
  if (!row) return null;
  if (row.status === 'local-only') return { category: 'added', info: 'Added · new file' };
  if (row.status === 'replace') return { category: 'edited', info: 'Edited · contents changed' };
  if (row.status === 'rename') {
    if (row.folderDiffers) {
      const folder = row.local?.folderPath || 'project root';
      return { category: 'moved', info: `Moved · now in ${folder}` };
    }
    const was = row.cloud?.name;
    return { category: 'edited', info: was ? `Renamed · was “${was}”` : 'Renamed' };
  }
  return null;
}

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
// Double-click → `onDoubleOpen(file)` opens the file in DocVex's
// in-app viewer (Word for DOCX, Chromium for image/PDF/video). The
// `onClick` prop is only wired by the "missing on My branch" variant,
// where single-click downloads the cloud file into the local folder.
function FileCard({ file, onClick, onDoubleOpen, branchOverlay }) {
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

  // Right-click → tooltip morphs into the same Open menu pattern
  // My-branch cards expose. Open is hidden when there's no dblclick
  // handler wired (e.g. the "missing" variant on My branch, where
  // the card is a download CTA rather than a viewable file).
  const morphPill = useMorphPill({
    hoverContent: tooltipText,
    menuItems: [
      onDoubleOpen && {
        key: 'open', label: 'Open', onClick: () => onDoubleOpen?.(file),
      },
    ],
  });

  return (
    <div
      className="project-files-card-wrap"
      onMouseMove={morphPill.handleMouseMove}
      onMouseLeave={morphPill.handleMouseLeave}
      onContextMenu={morphPill.handleContextMenu}
    >
      <button
        type="button"
        className={cardClass}
        // Single-click is only wired by the "missing" variant on My
        // branch (downloads the file into the local folder). Cloud
        // cards leave it unset — the viewer opens on double-click.
        onClick={onClick ? () => onClick(file) : undefined}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleOpen?.(file);
        }}
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
      {morphPill.node}
    </div>
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
function LocalFileCard({
  file,
  onSelect,            // single-click — just highlights the card
  onDoubleOpen,        // double-click — opens the file in its OS default app / Word / viewer
  onRevert,            // menu Revert — only shown when `modified` AND a cloud counterpart exists
  onDelete,            // menu Delete — see handleDeleteLocalCard in ProjectFiles
  modified,
  bytesChanged,        // true → local bytes diverge from cloud → regenerate thumbnail
                       //         from disk instead of showing the (now stale) cloud thumb
  selected,            // true → card paints the accent highlight ring
  cloud,
  overlay,
  localContentHash,    // SHA-256 of the on-disk bytes (from parent's localHashByName)
                       // — feeds into the descriptor's contentKey so an in-place
                       // edit invalidates every cache layer at once.
  canMove,             // true → card is draggable onto a folder card to move it
  shortcut,            // true → this is an alias (the real card lives in its
                       // category section); don't allow drag-to-move.
  shortcutBadge = shortcut, // whether to paint the corner shortcut arrow.
                       // Defaults to `shortcut` but can be turned off so an
                       // alias renders without the badge (e.g. the unsaved-
                       // edits chip, where "waiting for review" framing is wrong).
  changeCategory,      // 'added' | 'edited' | 'moved' | null — color-coded
                       // change dot in the card's top-left (any changed file)
  changeInfo,          // tooltip text shown when hovering the change dot
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
  // card title. The change dot already signals "differs from cloud",
  // so the tooltip doesn't repeat it.
  const tooltipBody = base;
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
  // Selection fires instantly on single click — no delay. Selecting
  // and "open" don't actually conflict: double-clicking just
  // selects + opens, which matches how Explorer behaves anyway.
  // Both handlers stopPropagation so the panel's bg-click deselect
  // doesn't fire on the same event.
  //
  // Single-click selects (highlight only). Double-click opens the
  // file via the parent's onDoubleOpen handler.
  const handleCardClick = (e) => {
    e?.stopPropagation?.();
    onSelect?.(file);
  };
  const handleCardDoubleClick = (e) => {
    e?.stopPropagation?.();
    onDoubleOpen?.(file);
  };

  // Right-click → tooltip morphs into a context menu via the shared
  // useMorphPill hook. Items conditionally appear (Revert when the
  // file diverges from cloud; Delete when the parent wired a handler).
  const morphPill = useMorphPill({
    hoverContent: tooltipBody,
    menuItems: [
      { key: 'open',     label: 'Open',             onClick: () => onDoubleOpen?.(file) },
      (onRevert && modified && cloud) && {
        key: 'revert',   label: 'Revert',           onClick: () => onRevert?.(file),
      },
      {
        key: 'reveal',   label: 'Show in explorer', onClick: () => file?.path && localFolderApi.showInFolder(file.path),
        disabled: !file?.path,
      },
      onDelete && {
        // "Hide" rather than "Delete" — the action removes the file
        // from the user's local working copy, NOT from main. If the
        // file has a cloud counterpart it re-surfaces as a "missing
        // — download" card on the next render, so the operation
        // really is "stop showing this here." Marked danger because
        // for local-only files (no cloud row yet) it's still an
        // irreversible rm.
        //
        // The confirm step lives INSIDE the morph pill — useMorphPill
        // sees the `confirm` payload and morphs the menu shape into a
        // confirmation panel via the same FLIP animation that grew
        // the tooltip into the menu. Replaces the old window.confirm
        // bridge, which broke the visual continuity by handing off
        // to the OS dialog mid-interaction.
        key: 'hide',     label: 'Hide',             onClick: () => onDelete?.(file),
        danger: true,
        confirm: {
          title: 'Hide this file?',
          message: `"${file?.name}" will disappear from your view. The file stays on disk — use "Show hidden" near the tabs to bring it back.`,
          confirmLabel: 'Hide',
          cancelLabel: 'Cancel',
        },
      },
    ],
  });

  return (
    <div
      className="project-files-local-card-wrap"
      onMouseMove={morphPill.handleMouseMove}
      onMouseLeave={morphPill.handleMouseLeave}
      onContextMenu={morphPill.handleContextMenu}
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
        tabIndex={0}
        className={`project-files-card${selected ? ' is-selected' : ''}`}
        draggable={Boolean(canMove && file?.path && !shortcut)}
        onDragStart={canMove && file?.path && !shortcut ? (e) => {
          e.dataTransfer.setData(MOVE_DND_TYPE, file.path);
          e.dataTransfer.effectAllowed = 'move';
        } : undefined}
        onClick={handleCardClick}
        onDoubleClick={handleCardDoubleClick}
        onKeyDown={(e) => {
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
          <FileThumbnail descriptor={descriptor} hovered={hovered} />
          {ext && (
            <span className="project-files-ext" aria-hidden="true">
              {ext.toUpperCase()}
            </span>
          )}
          {shortcutBadge && (
            <span
              className="project-files-shortcut-badge"
              title="Shortcut — waiting for review"
              aria-label="Shortcut — waiting for review"
            >
              {ShortcutGlyph}
            </span>
          )}
        </div>
        {changeCategory && (
          // Color-coded change dot pinned to the thumbnail's top-left
          // corner. Lives OUTSIDE .project-files-thumb (which clips with
          // overflow:hidden) so it can sit right on the edge / overhang the
          // corner. Hovering it shows the cursor-pill Tooltip; we hide the
          // card's own morph-pill hover and stop the move event from
          // bubbling so only the dot's tooltip shows over the dot.
          <span
            className="project-files-change-dot-wrap"
            onMouseEnter={morphPill.handleMouseLeave}
            onMouseMove={(e) => e.stopPropagation()}
          >
            <Tooltip content={changeInfo}>
              <span
                className={`project-files-change-dot is-${changeCategory}`}
                role="img"
                aria-label={changeInfo || changeCategory}
              />
            </Tooltip>
          </span>
        )}
        <div className="project-files-meta">
          <div className="project-files-name">{base || file.name}</div>
        </div>
      </div>
      {morphPill.node}
    </div>
  );
}

// A subfolder tile on the My branch. Click opens it (navigation);
// right-click morphs the tooltip into Open / Rename / Delete (Delete
// confirms inline via the same FLIP panel the file card uses). It is
// also a drop target — dragging a file card onto it moves that file
// inside. Folders are a LOCAL organisation layer (the cloud stays
// flat); these never touch Supabase.
function LocalFolderCard({ dir, onOpen, onRename, onDelete, onMoveFile }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(dir.name);
  const [dropActive, setDropActive] = useState(false);

  const commitRename = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== dir.name) onRename?.(dir, next);
    else setDraft(dir.name);
  };

  const morphPill = useMorphPill({
    hoverContent: dir.name,
    menuItems: [
      { key: 'open', label: 'Open', onClick: () => onOpen?.(dir) },
      { key: 'rename', label: 'Rename', onClick: () => { setDraft(dir.name); setRenaming(true); } },
      {
        key: 'delete', label: 'Delete', danger: true, onClick: () => onDelete?.(dir),
        confirm: {
          title: 'Delete this folder?',
          message: `"${dir.name}" and everything inside it is permanently removed from your computer. This can't be undone.`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
        },
      },
    ],
  });

  const acceptsDrop = (e) => Array.from(e.dataTransfer.types || []).includes(MOVE_DND_TYPE);

  return (
    <div
      className={`project-files-local-card-wrap${dropActive ? ' is-drop-target' : ''}`}
      onMouseMove={renaming ? undefined : morphPill.handleMouseMove}
      onMouseLeave={morphPill.handleMouseLeave}
      onContextMenu={renaming ? undefined : morphPill.handleContextMenu}
      onDragOver={(e) => { if (acceptsDrop(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true); } }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        if (!acceptsDrop(e)) return;
        e.preventDefault();
        setDropActive(false);
        const fromPath = e.dataTransfer.getData(MOVE_DND_TYPE);
        if (fromPath) onMoveFile?.(fromPath, dir.path);
      }}
    >
      <div
        role="button"
        tabIndex={0}
        className="project-files-card project-files-folder-card"
        // Open on double-click only (single click just selects / stops
        // the panel-bg deselect). Enter is the keyboard equivalent.
        onClick={(e) => { e.stopPropagation(); }}
        onDoubleClick={(e) => { e.stopPropagation(); if (!renaming) onOpen?.(dir); }}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === 'Enter') { e.preventDefault(); onOpen?.(dir); }
        }}
      >
        <div className="project-files-thumb project-files-folder-thumb">
          <span className="project-files-folder-icon">{folderGlyphFor(dir.empty)}</span>
        </div>
        <div className="project-files-meta">
          {renaming ? (
            <input
              className="project-files-folder-rename-input"
              value={draft}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') { setRenaming(false); setDraft(dir.name); }
              }}
              onBlur={commitRename}
            />
          ) : (
            <div className="project-files-name" title={dir.name}>{dir.name}</div>
          )}
        </div>
      </div>
      {morphPill.node}
    </div>
  );
}

// Inline create-folder tile rendered at the head of the Folders grid
// while the user is naming a new folder. Enter commits, Escape cancels,
// blur commits a non-empty name (else cancels) — Explorer-like.
function NewFolderInput({ onCommit, onCancel }) {
  const [name, setName] = useState('');
  return (
    <div className="project-files-local-card-wrap">
      <div className="project-files-card project-files-folder-card is-creating">
        <div className="project-files-thumb project-files-folder-thumb">
          <span className="project-files-folder-icon">{FolderGlyph}</span>
        </div>
        <div className="project-files-meta">
          <input
            className="project-files-folder-rename-input"
            value={name}
            autoFocus
            placeholder="Folder name"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onCommit?.(name);
              else if (e.key === 'Escape') onCancel?.();
            }}
            onBlur={() => { if (name.trim()) onCommit?.(name); else onCancel?.(); }}
          />
        </div>
      </div>
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
  // Selection highlight for My-branch local cards. Single click sets
  // this; double-click opens the file via the OS / in-app viewer.
  // Keyed by `file.path`
  // so a re-render with the same disk path keeps the selection.
  const [selectedLocalPath, setSelectedLocalPath] = useState(null);
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

  // My-branch layout mode: 'category' groups files into Photos / Videos /
  // Documents sections (the default); 'all' shows one Explorer-style grid
  // with folders first, then files, each alphabetical. Persisted per-project.
  const MY_VIEW_KEY = projectId ? `docvex:project-files-my-view:${projectId}` : null;
  const [myViewMode, setMyViewMode] = useState(() => {
    if (!MY_VIEW_KEY) return 'category';
    try {
      return localStorage.getItem(MY_VIEW_KEY) === 'all' ? 'all' : 'category';
    } catch { return 'category'; }
  });
  useEffect(() => {
    if (!MY_VIEW_KEY) return;
    try { localStorage.setItem(MY_VIEW_KEY, myViewMode); }
    catch { /* private mode — fall back to in-memory only */ }
  }, [MY_VIEW_KEY, myViewMode]);

  // Hidden filenames — per-(user, project) lowercase Set persisted in
  // localStorage. Filtered out of the My-branch grid render below;
  // the on-disk files stay untouched, sidecar entries stay intact,
  // so toggling Show all (the chip near the scope buttons) restores
  // everything without re-running any disk I/O. See src/lib/hiddenFiles.js
  // for the storage shape.
  const [hiddenFiles, setHiddenFiles] = useState(new Set());
  useEffect(() => {
    setHiddenFiles(loadHiddenFiles(userId, projectId));
  }, [userId, projectId]);
  const hideFilename = useCallback((name) => {
    if (!name) return;
    const lc = name.toLowerCase();
    setHiddenFiles((prev) => {
      if (prev.has(lc)) return prev;
      const next = new Set(prev);
      next.add(lc);
      saveHiddenFiles(userId, projectId, next);
      return next;
    });
  }, [userId, projectId]);
  const showAllHidden = useCallback(() => {
    setHiddenFiles((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set();
      saveHiddenFiles(userId, projectId, next);
      return next;
    });
  }, [userId, projectId]);
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
    mainVersion,
    branchState,
    refresh: refreshBranchState,
    queueChange,
    discardAll,
    withdrawRequest,
    approveRelease,
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

  // ── Folder navigation (My-branch local organisation) ──────────────
  // `localFiles` above stays the ROOT listing — the branch sync diffs
  // against it, so navigating into a subfolder must NOT disturb it.
  // Folder browsing is a separate listing layer:
  //   • folderStack — the descended subfolders (breadcrumb), [] = root.
  //   • browseFiles/browseDirs — listing of the CURRENT directory.
  //   • browseTick — bumped to force a re-list after a folder action.
  // Only the Electron backend supports in-app folder navigation; the
  // web FSA backend tracks a single flat handle, so folders are hidden
  // there and the grid keeps reading `localFiles` directly.
  const supportsFolders = isElectronBranch;
  const [folderStack, setFolderStack] = useState([]); // [{ name, path }]
  // Per-directory listing cache (dir path → { files, dirs }). `atRoot`
  // flips synchronously on navigation, but a fresh listing only lands after
  // the async list() resolves. Caching lets navigation to an already-visited
  // folder (e.g. back to root) paint instantly from the cached listing —
  // no async-list lag and, crucially, no stale-subfolder-then-root reflow,
  // which is what made folder navigation jutter. The effect still re-lists
  // the current dir in the background on every visit so the cache self-heals
  // if the folder changed while we were away. A dir being present in the
  // cache also means "this listing is real" (not navigation-in-flight), so
  // the grid won't render root's missing-download ghosts against a stale set.
  const [browseCache, setBrowseCache] = useState(() => new Map());
  const [browseTick, setBrowseTick] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  // Right-click-the-background menu (My branch): { x, y } | null.
  const [bgMenu, setBgMenu] = useState(null);
  const atRoot = folderStack.length === 0;
  const currentDir = atRoot ? localFolder : folderStack[folderStack.length - 1].path;
  // Listing for the directory we're viewing, derived from the cache so a
  // revisit is synchronous. `browseFresh` is false only on a first visit
  // while the async list is still in flight.
  const browseListing = browseCache.get(currentDir);
  const browseFiles = browseListing?.files || [];
  const browseDirs = browseListing?.dirs || [];
  const browseFresh = !supportsFolders || browseCache.has(currentDir);
  // Main-branch (cloud) folder navigation — a relative path string
  // ('' = root) since cloud files have no on-disk path, just a
  // folder_path column. Independent of the My-branch folderStack.
  const [mainFolderPath, setMainFolderPath] = useState('');

  // Background SHA-256 cache for local files — keyed by
  // `${name}|${mtimeIso}` so an Explorer edit (which bumps mtime)
  // invalidates the entry automatically. The hashing effect below
  // walks `localFiles` whenever it changes and fills the map; the
  // diff effect re-runs as entries land, so the UI gracefully
  // upgrades from a size-based diff to a hash-based one over a
  // second or two on first load.
  const [localHashByName, setLocalHashByName] = useState(new Map());
  const hashCacheRef = useRef(new Map()); // `${name}|${mtime}` → hex
  // Has the first hashing pass over the current folder finished? Until it
  // has, a same-size content edit isn't detected yet (the diff is still
  // size-based), so the status pill would briefly read "Up to date" before
  // flipping to "unsaved edits". We hold the "Up to date" claim until this
  // is true and show a neutral "Checking…" state instead — no false-synced
  // flash on entry. Reset when the folder changes; set when a pass completes.
  const [hashPassDone, setHashPassDone] = useState(false);
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
      if (cancelled) return;
      if (dirty) setLocalHashByName(next);
      // Pass finished over the current localFiles — the hash-based diff is
      // now trustworthy, so "Up to date" can be shown without risking the
      // false-synced flash. Not reset per-pass (only on folder change), so
      // a watcher-triggered re-hash doesn't blink the pill.
      setHashPassDone(true);
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

  useEffect(() => {
    if ((openOwnRequestItems || []).length > 0) {
      lastOpenItemsRef.current = openOwnRequestItems;
    }
  }, [openOwnRequestItems]);

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
  // Per-file send progress while a push is in flight: { current, total }
  // (from runCommitFlow's onProgress) or null before the first file /
  // when there are no byte uploads (metadata-only push). Drives the
  // progress bar at the bottom of the unsaved-edits chip.
  const [pushProgress, setPushProgress] = useState(null);
  // The unsaved-edits / waiting-for-review chip lists the affected files
  // beneath its header. That list is collapsed by default (just the
  // summary line shows); the chevron toggles it open with an animated
  // height transition. Kept here at the page level so it survives the
  // chip re-rendering as the diff updates.
  const [unsavedExpanded, setUnsavedExpanded] = useState(false);
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
    setPushProgress(null);
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
        onProgress: ({ current, total }) => setPushProgress({ current, total }),
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
      setPushProgress(null);
    }
  }, [pushing, branchView, projectId, userId, branchDiff, pendingChanges, notify, refreshOpenRequestItems]);

  // ── Unpublish (withdraw) ────────────────────────────────────────────
  // The "Discard" action on the Waiting-for-review chip. Pulls the user's
  // own open change request(s) back to 'withdrawn' WITHOUT touching the
  // local folder — the edited files stay on disk. Once the request is no
  // longer open the diff stops treating those items as "in review", so
  // they re-surface as unsaved local edits (the chip flips back to "You
  // have unsaved edits", Push available again). Distinct from the
  // unsaved-state Discard, which reverts the folder to the cloud version.
  const [withdrawing, setWithdrawing] = useState(false);
  const handleWithdrawOwnRequests = useCallback(async () => {
    if (withdrawing) return;
    const openOwn = (changeRequests || []).filter(
      (r) => r.author_id === userId && r.status === 'open',
    );
    if (openOwn.length === 0) return;
    setWithdrawing(true);
    try {
      const results = await Promise.all(openOwn.map((r) => withdrawRequest(r.id)));
      const failed = results.filter((r) => r?.error).length;
      notify?.({
        category: 'file',
        variant: failed > 0 ? 'error' : 'success',
        title: failed > 0 ? 'Couldn’t unpublish everything' : 'Edits unpublished',
        body: failed > 0
          ? `${openOwn.length - failed} of ${openOwn.length} pulled back — try again.`
          : 'Your edits are back as unsaved changes — still in your folder, just not sent for review.',
        dedupeKey: 'withdraw-own-result',
      });
      // Reload the request list (don't wait on Realtime). That drops the
      // withdrawn request from the open set, which cascades: openOwnRequestIds
      // recomputes → open items refetch → the diff re-surfaces the edits →
      // the chip flips from "Waiting for review" to "You have unsaved edits".
      await refreshBranchState?.();
    } finally {
      setWithdrawing(false);
    }
  }, [withdrawing, changeRequests, userId, withdrawRequest, notify, refreshBranchState]);

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

  // FileIds with an item in the user's open change request — work already
  // pushed and now awaiting an admin's review. Drives the "Waiting for
  // review" shortcut section on the My branch. Mirrors computeSyncState's
  // covered-id derivation: an 'add' keys off the minted proposed.id,
  // every other kind off target_file_id. Uses effectiveOpenItems so the
  // section stays stable through the ~4s post-approval soft-hold window.
  const waitingReviewFileIds = useMemo(() => {
    const s = new Set();
    for (const it of effectiveOpenItems) {
      if (it.kind === 'add') {
        if (it.proposed?.id) s.add(it.proposed.id);
      } else if (it.target_file_id) {
        s.add(it.target_file_id);
      }
    }
    return s;
  }, [effectiveOpenItems]);

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
      const { files: localList, error: listErr } = await localFolderApi.listAll(localFolder);
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
      localFolderApi.listAll(localFolder).then(({ files: localList, error: listErr }) => {
        if (listErr) return;
        setLocalFiles(localList || []);
      });
      // Also refresh the folder-browse listing (root or subfolder) so
      // an external add/remove shows up while navigating folders too.
      setBrowseTick((t) => t + 1);
    });
    return () => {
      unsub?.();
      localFolderApi.unwatch();
    };
  }, [localFolder]);

  // Reset folder navigation when the project / picked folder changes —
  // a subfolder path from one folder is meaningless in another.
  useEffect(() => {
    setFolderStack([]);
    setCreatingFolder(false);
    setBrowseCache(new Map());
    setHashPassDone(false);
  }, [projectId, localFolder]);
  useEffect(() => { setMainFolderPath(''); }, [projectId]);

  // Browse listing — drives the displayed grid for the CURRENT directory
  // (root or a descended subfolder). Kept separate from `localFiles`
  // (the root listing the branch sync diffs against) so navigating into
  // a subfolder can't make the sync think every root file was deleted.
  useEffect(() => {
    if (branchView !== 'mine' || !supportsFolders || !localFolder) {
      return undefined;
    }
    let cancelled = false;
    const writeCache = (files, dirs) => {
      setBrowseCache((prev) => {
        const next = new Map(prev);
        next.set(currentDir, { files: files || [], dirs: dirs || [] });
        return next;
      });
    };
    localFolderApi.list(currentDir).then(({ files: bf, dirs: bd }) => {
      if (cancelled) return;
      writeCache(bf, bd);
    }).catch(() => {
      if (!cancelled) writeCache([], []);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchView, supportsFolders, localFolder, currentDir, browseTick]);

  // ── Folder actions (local organisation layer) ─────────────────────
  const handleEnterFolder = useCallback((dir) => {
    if (!dir?.path) return;
    setCreatingFolder(false);
    setFolderStack((stack) => [...stack, { name: dir.name, path: dir.path }]);
  }, []);

  // Jump to a breadcrumb level. index === -1 → root.
  const handleNavigateCrumb = useCallback((index) => {
    setCreatingFolder(false);
    setFolderStack((stack) => (index < 0 ? [] : stack.slice(0, index + 1)));
  }, []);

  const handleCreateFolder = useCallback(async (name) => {
    setCreatingFolder(false);
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    const { error } = await localFolderApi.createFolder({ dir: currentDir, name: trimmed });
    if (error) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t create folder', body: error, dedupeKey: 'folder-create-error' });
      return;
    }
    setBrowseTick((t) => t + 1);
  }, [currentDir, notify]);

  const handleRenameFolder = useCallback(async (dir, newName) => {
    const { error } = await localFolderApi.renameFile({ dir: currentDir, fromName: dir.name, toName: newName });
    if (error) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t rename folder', body: error, dedupeKey: 'folder-rename-error' });
      return;
    }
    setBrowseTick((t) => t + 1);
  }, [currentDir, notify]);

  const handleDeleteFolder = useCallback(async (dir) => {
    const { error } = await localFolderApi.deleteFolder({ dir: currentDir, name: dir.name });
    if (error) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t delete folder', body: error, dedupeKey: 'folder-delete-error' });
      return;
    }
    setBrowseTick((t) => t + 1);
  }, [currentDir, notify]);

  // Move a file into a folder (drag-drop). `toDir` is the destination's
  // absolute path. Refreshes BOTH the browse view and the root sync
  // listing — a file leaving/entering the root changes what the branch
  // diff sees (subfolder files are local-only, not part of the project).
  const handleMoveLocalFile = useCallback(async (fromPath, toDir) => {
    if (!fromPath || !toDir) return;
    const { error } = await localFolderApi.move({ root: localFolder, fromPath, toDir });
    if (error) {
      notify({ category: 'file', variant: 'error', title: 'Couldn’t move file', body: error, dedupeKey: 'file-move-error' });
      return;
    }
    setBrowseTick((t) => t + 1);
    const { files: localList, error: listErr } = await localFolderApi.listAll(localFolder);
    if (!listErr) setLocalFiles(localList || []);
  }, [localFolder, notify]);

  // Right-click on the empty grid background (My branch) → a small menu
  // with "Make new folder" + "Import". Ignores right-clicks that landed
  // on a card / button (those carry their own context actions).
  const handleBgContextMenu = useCallback((e) => {
    if (branchView !== 'mine' || !supportsFolders || !localFolder) return;
    if (e.target.closest?.('.project-files-local-card-wrap')
      || e.target.closest?.('.project-files-card')
      || e.target.closest?.('button')
      || e.target.closest?.('input')) return;
    e.preventDefault();
    setBgMenu({ x: e.clientX, y: e.clientY });
  }, [branchView, supportsFolders, localFolder]);

  // Dismiss the background menu on outside click / scroll / Escape.
  useEffect(() => {
    if (!bgMenu) return undefined;
    const close = () => setBgMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [bgMenu]);

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

  // Double-click on a cloud card. Signs a fresh URL for the canonical
  // bytes (the modal's poster URL is too short-lived to reuse here)
  // and pops the in-app viewer. DOCX routes through openDocx (Word →
  // Office Online → OS default); browser-native types open in a
  // dedicated BrowserWindow loading the signed URL directly.
  //
  // 1800 s (30 min) TTL: Word + Office Online may fetch the URL up
  // to a minute after we sign it (UI handoff, app cold-start), and
  // Office Online's servers occasionally retry. A short 5-min TTL
  // like the modal's preview uses produced "URL expired" failures.
  const handleOpenCloudFileViewer = useCallback(async (file) => {
    if (!file?.storage_path) return;
    if (!canOpenInApp(file.mime_type, file.name)) return;
    const { data, error } = await createSignedDownloadUrl(file.storage_path, 1800);
    if (error || !data?.signedUrl) {
      notify({
        category: 'file',
        variant: 'error',
        title: 'Could not open file',
        body: error?.message || 'Try again in a moment.',
        dedupeKey: `file-view-error:${file.id}`,
      });
      return;
    }
    if (isDocxFile(file.mime_type, file.name)) {
      // View .docx in a separate window, rendered via docx-preview.
      // On render failure, fall back to opening in Word / Office Online.
      const fname = file.name || 'file';
      openDocxInWindow({ signedUrl: data.signedUrl, fileName: fname }).then((res) => {
        if (res?.error) {
          notify({
            category: 'file',
            variant: 'error',
            title: 'Couldn’t render document',
            body: 'Opening it in Word instead.',
            dedupeKey: `docx-render-fallback:${file.id}`,
          });
          openDocx({ cloudUrl: data.signedUrl, fileName: fname });
        }
      });
      return;
    }
    openFileWindow(data.signedUrl, file.name || 'file');
  }, [notify]);

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
      files: [{ url: data.signedUrl, filename, subdir: cloudFile.folder_path || '' }],
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
    const { files: localList } = await localFolderApi.listAll(localFolder);
    setLocalFiles(localList || []);
  }, [localFolder, notify]);

  // Ctrl+wheel resize. cardSize hydrates from localStorage so the
  // user's last-chosen size sticks across reloads and project switches.
  // The wheel listener attaches via a native addEventListener (not
  // React's onWheel) because we need `{ passive: false }` to call
  // preventDefault and suppress the browser's default ctrl+wheel zoom.
  const pageRef = useRef(null);
  const [cardSize, setCardSize] = useState(readCachedCardSize);

  // Files-tab redesign: which plain-language tab is active. team = cloud
  // (Team files); drafts/review/trash are status-filtered branch views.
  // Declared up here (with the other hooks) so it sits ABOVE the
  // selectedProject early-return guards — Rules of Hooks.
  const [filesTab, setFilesTab] = useState('team');
  // The redesign drops the Main/Yours toggle, but the branch derivations
  // (syncState, hashing, browse listing) only run when branchView==='mine'.
  // Force it so drafts/review/trash always have data, while cloud files
  // (loaded independently of branchView) still power the Team tab.
  useEffect(() => { setBranchViewRaw('mine'); }, [setBranchViewRaw]);

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
    const { files: localList, error: listErr } = await localFolderApi.listAll(localFolder);
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
    // Import into the folder the user is currently browsing (root or a
    // subfolder), so right-click → Import inside a folder lands there.
    const { results, error: writeErr } = await localFolderApi.writeFiles({
      dir: currentDir,
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
    // currentDir MUST be in deps — without it the callback closes over the
    // root and imports land there even after navigating into a subfolder.
  }, [localFolder, currentDir, notify, refetchLocalFiles]);

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
      // Echo-driven hold instead of a fixed 4 s timer. The old version
      // cleared the held items via setTimeout, which leaked across
      // back-to-back approvals: a second approval's timer would clear
      // the FIRST approval's hold prematurely (its items had cleared)
      // while the second's items were still mid-flight, producing a
      // flicker. Now we snapshot the held items, immediately refetch
      // cloud + local files + branch state, and clear the hold the
      // moment the cloud refetch resolves — by then the just-merged
      // items live in `files` and the diff layer no longer needs the
      // hold to suppress them.
      if (lastOpenItemsRef.current.length > 0) {
        setHeldApprovedItems(lastOpenItemsRef.current);
      }
      // Sequential — start the cloud refetch first; once its results
      // land in `files`, drop the hold. Local + branch refresh fire
      // concurrently since neither feeds the hold-clear condition.
      (async () => {
        try { await refetchCloudFiles(); } finally {
          setHeldApprovedItems([]);
        }
      })();
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

  // Auto-update the Team (main-branch) view whenever a new version is
  // published. BranchContext bumps `mainVersion` when a change request is
  // approved/merged (its own change_requests realtime sub), so a version
  // change is the signal that main's files moved — refetch the canonical
  // list. This backstops the per-row project_files realtime above so the
  // Team tab is always current after a merge, by anyone.
  const lastMainVersionRef = useRef(mainVersion);
  useEffect(() => {
    if (lastMainVersionRef.current === mainVersion) return;
    lastMainVersionRef.current = mainVersion;
    refetchCloudFiles();
  }, [mainVersion, refetchCloudFiles]);

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

  // Double-click on a local card (My drafts). These are the user's real
  // files on disk, so everything hands off to native software rather than
  // an in-app viewer:
  //   • DOCX        → openDocx with ONLY the local path → native Word (or
  //                   the OS's default .docx app). We deliberately do NOT
  //                   pass a cloud URL: main's open-docx routes any cloudUrl
  //                   to the read-only in-app Office Online viewer, which
  //                   isn't what "open my draft to edit it" means — and
  //                   edits to the local file save in place + the watcher
  //                   picks them up into the diff layer.
  //   • Anything else → OS default app via shell.openPath, so a double-click
  //                   hands off to the user's actual editor (Word, Preview,
  //                   Photos, Acrobat, …). (On web, openPath / a local-only
  //                   openDocx are both no-ops — there's no native app.)
  const handleOpenLocalFile = useCallback(async (file) => {
    if (!hasLocalFolderApi || !file?.path) return;
    if (isDocxFile(file.mimeType, file.name)) {
      openDocx({ localPath: file.path, fileName: file.name || 'file' });
      return;
    }
    localFolderApi.openPath(file.path);
  }, []);

  // Hide the card from the My-branch grid. Pure presentation filter —
  // the file is NOT removed from disk, the sidecar entry stays intact,
  // bytes stay claimable / pushable / hashable. The renderer below
  // filters `localFiles` by `hiddenFiles` before bucketing, so a
  // hidden card just disappears. Persists per-(user, project) in
  // localStorage via the hideFilename helper above, so the hide
  // sticks across reloads.
  //
  // The morph-pill's confirm step in LocalFileCard's menu items gates
  // entry to this handler — by the time it runs the user has already
  // confirmed in the in-pill panel. There's no failure path that
  // needs an error toast: localStorage writes either succeed or
  // silently degrade to in-memory (safeWrite swallows quota errors).
  // The success toast keeps the user oriented when the card vanishes
  // from the grid, and includes a "Show hidden" affordance on the
  // scope toggle bar for unhiding.
  const handleDeleteLocalCard = useCallback((localFile) => {
    if (!localFile?.name) return;
    hideFilename(localFile.name);
    notify({
      category: 'file',
      variant: 'success',
      icon: 'trash',
      title: 'Marked for deletion',
      body: `"${localFile.name}" will be removed from the team’s files when you publish. The file stays on your computer.`,
      dedupeKey: `mark-delete-local:${localFile.path}`,
    });
  }, [hideFilename, notify]);

  // Single-click selection — just highlights the card. Re-clicking
  // the already-selected card deselects (matches OS file managers).
  const handleSelectLocalCard = useCallback((localFile) => {
    setSelectedLocalPath((prev) => (prev === localFile.path ? null : localFile.path));
  }, []);

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
      files: [{ url: data.signedUrl, filename: cloudFilename, subdir: cloud.folder_path || '' }],
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

  // Render a single on-disk file as a LocalFileCard. Shared by the grid's
  // category sections AND the "Waiting for review" shortcut list under the
  // status pill, so both derive the cloud link / Modified state the same
  // way. `shortcut` shows the alias badge + disables drag-to-move;
  // `keyPrefix` keeps React keys unique when the same file renders twice.
  const buildLocalCard = (f, { shortcut = false, shortcutBadge = shortcut, keyPrefix = '' } = {}) => {
    const lcName = (f.name || '').toLowerCase();
    // Sidecar-driven cloud resolution: filename → fileId → cloud. A null
    // cloud means "local-only file not yet pushed".
    const fileId = sidecar.byFilename.get(lcName);
    const cloud = fileId ? cloudById.get(fileId) : null;
    // "Modified" mirrors the status chip's filter (open-request items
    // hidden, soft-hold applied) via diffReplaceCloudIds.
    const bytesDiffer = Boolean(cloud) && diffReplaceCloudIds.has(cloud.id);
    // Bytes (not rename) diverged → regenerate thumb from disk.
    const bytesChanged = Boolean(cloud) && bytesDifferCloudIds.has(cloud.id);
    // Un-pushed metadata edit (rename / description).
    const overlay = cloud ? overlayByFileId.get(cloud.id) : null;
    const isModified = bytesDiffer || Boolean(overlay);
    // Change-category dot — derived from the file's syncState row, so EVERY
    // changed card (added / edited / moved) gets one, not just the review
    // shortcuts. Unchanged (synced) files get null → no dot.
    const change = describeChange(fileId ? syncState?.rows.get(fileId) : null);
    return (
      <LocalFileCard
        key={`${keyPrefix}${f.path}`}
        file={f}
        onSelect={handleSelectLocalCard}
        onDoubleOpen={handleOpenLocalFile}
        onRevert={handleRevertLocalCard}
        onDelete={handleDeleteLocalCard}
        selected={selectedLocalPath === f.path}
        modified={isModified}
        bytesChanged={bytesChanged}
        cloud={cloud}
        overlay={overlay}
        localContentHash={localHashByName.get(f.name) || null}
        canMove={supportsFolders}
        shortcut={shortcut}
        shortcutBadge={shortcutBadge}
        changeCategory={change?.category || null}
        changeInfo={change?.info || null}
      />
    );
  };

  // On-disk files that are awaiting review (have an item in the user's open
  // change request). Pulled from syncState.rows so it's project-wide
  // regardless of which subfolder is being browsed; deletes have no local
  // file and drop out. Sorted by name for a stable order.
  const waitingReviewFiles = (() => {
    if (waitingReviewFileIds.size === 0 || !syncState) return [];
    const out = [];
    for (const fileId of waitingReviewFileIds) {
      const row = syncState.rows.get(fileId);
      if (row?.local) out.push(row.local);
    }
    out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return out;
  })();

  // On-disk files with unsaved local edits (not yet pushed). Mirrors
  // waitingReviewFiles so the "You have unsaved edits" chip can list the
  // same shortcut cards as the "Waiting for review" chip. Sources both
  // detected filesystem diffs (branchDiff) and queued metadata changes
  // (pendingChanges → resolved to their on-disk file via syncState.rows);
  // deletes have no local file and drop out. Deduped + name-sorted.
  const unsavedEditFiles = (() => {
    if (!syncState) return [];
    const seen = new Set();
    const out = [];
    for (const it of branchDiff) {
      const fid = it.fileId;
      if (!fid || seen.has(fid)) continue;
      const local = it.local || syncState.rows.get(fid)?.local;
      if (local) { seen.add(fid); out.push(local); }
    }
    for (const c of pendingChanges) {
      const fid = c.target_file_id;
      if (!fid || seen.has(fid)) continue;
      const local = syncState.rows.get(fid)?.local;
      if (local) { seen.add(fid); out.push(local); }
    }
    out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return out;
  })();

  // ════════════════════════════════════════════════════════════════════
  // Files-tab redesign — builds the data model + handlers that drive the
  // <FilesWorkspace> presentational component (the File-Explorer UI from
  // the Claude Design handoff). All the heavy branch/sync logic above is
  // reused as-is; this section just maps it onto the new UI's shape.
  // The legacy render lives in _LegacyFilesRender_ below (not in the path).
  // ════════════════════════════════════════════════════════════════════

  const fileExtOf = (name) => (splitNameAndExtension(name).ext || '').toLowerCase();

  // Build a workspace item from a cloud row.
  const cloudItem = (row, status) => ({
    id: row.id,
    kind: 'file',
    name: row.name,
    ext: fileExtOf(row.name),
    sizeLabel: formatBytes(row.size_bytes),
    modifiedLabel: formatDate(row.uploaded_at),
    author: '',
    status: status || 'synced',
    descriptor: describeCloudFile(row),
    _raw: row,
    _isCloud: true,
  });

  // Build a workspace item from an on-disk file (My-branch).
  const localItem = (lf, status) => {
    const lcName = (lf.name || '').toLowerCase();
    const fid = sidecar.byFilename.get(lcName);
    const cloud = fid ? cloudById.get(fid) : null;
    const bytesChanged = Boolean(cloud) && bytesDifferCloudIds.has(cloud.id);
    const isWeb = typeof lf.path === 'string' && lf.path.startsWith('web://');
    const localUrl = (!isWeb && lf.path)
      ? `localfile://local/${encodeURIComponent(lf.path)}${lf.mtimeIso ? `?t=${encodeURIComponent(lf.mtimeIso)}` : ''}`
      : null;
    return {
      id: fid || lf.path || lf.name,
      kind: 'file',
      name: lf.name,
      ext: fileExtOf(lf.name),
      sizeLabel: lf.sizeBytes != null ? formatBytes(lf.sizeBytes) : (cloud ? formatBytes(cloud.size_bytes) : ''),
      modifiedLabel: formatDate(lf.mtimeIso),
      author: 'You',
      status,
      descriptor: describeLocalFile({ localFile: lf, localUrl, cloud, bytesChanged, localContentHash: localHashByName.get(lf.name) || null }),
      _raw: lf,
      _isCloud: false,
    };
  };

  const draftStatusFor = (lf) => {
    const fid = sidecar.byFilename.get((lf.name || '').toLowerCase());
    const ch = describeChange(fid ? syncState?.rows.get(fid) : null);
    return ch?.category === 'added' ? 'new' : 'edited';
  };

  // Sync status for an on-disk file (used in the Team tab's local browse).
  const statusForLocal = (lf) => {
    const fid = sidecar.byFilename.get((lf.name || '').toLowerCase());
    const cloud = fid ? cloudById.get(fid) : null;
    if ((cloud && waitingReviewFileIds.has(cloud.id)) || (fid && waitingReviewFileIds.has(fid))) return 'waiting';
    const row = fid ? syncState?.rows.get(fid) : null;
    if (row && row.status && row.status !== 'synced') {
      return describeChange(row)?.category === 'added' ? 'new' : 'edited';
    }
    return 'synced';
  };

  const teamLocalMode = Boolean(localFolder) && supportsFolders;

  // Team tab = the CLOUD / main branch (read-only): folders derived from the
  // cloud files' folder_path + the cloud files in the current cloud folder.
  const teamCur = mainFolderPath;
  const teamPrefix = teamCur ? `${teamCur}/` : '';
  const teamInFolder = files.filter((f) => (f.folder_path || '') === teamCur);
  const teamSubSet = new Set();
  for (const f of files) {
    const fp = f.folder_path || '';
    if (teamCur === '') { if (fp) teamSubSet.add(fp.split('/')[0]); }
    else if (fp.startsWith(teamPrefix)) { teamSubSet.add(fp.slice(teamPrefix.length).split('/')[0]); }
  }
  // How many files live under a folder (recursive). Cloud counts come from
  // the flat `files` list keyed by folder_path; local counts from the
  // recursive `localFiles` listing keyed by on-disk path prefix.
  const countCloudFilesUnder = (folderPath) => {
    if (!folderPath) return 0;
    const pre = `${folderPath}/`;
    let n = 0;
    for (const f of files) {
      const fp = f.folder_path || '';
      if (fp === folderPath || fp.startsWith(pre)) n += 1;
    }
    return n;
  };
  const countLocalFilesUnder = (dirPath) => {
    if (!dirPath) return 0;
    const sep = dirPath.includes('\\') ? '\\' : '/';
    const prefix = dirPath.endsWith(sep) ? dirPath : dirPath + sep;
    let n = 0;
    for (const lf of localFiles) {
      if (typeof lf.path === 'string' && lf.path.startsWith(prefix)) n += 1;
    }
    return n;
  };
  const fileCountLabel = (n) => `${n} ${n === 1 ? 'file' : 'files'}`;

  // "Waiting for review" only lists files in an open change request, so its
  // folder column must hide subfolders that hold none — otherwise they show
  // as empty folders. These check the recursive waiting set by on-disk path
  // prefix (same scheme as countLocalFilesUnder).
  const reviewWaitingPaths = waitingReviewFiles
    .map((f) => f.path)
    .filter((p) => typeof p === 'string');
  const waitingPrefixOf = (dirPath) => {
    const sep = dirPath.includes('\\') ? '\\' : '/';
    return dirPath.endsWith(sep) ? dirPath : dirPath + sep;
  };
  const folderHasWaiting = (dirPath) => {
    if (!dirPath) return false;
    const prefix = waitingPrefixOf(dirPath);
    return reviewWaitingPaths.some((p) => p.startsWith(prefix));
  };
  const countWaitingUnder = (dirPath) => {
    if (!dirPath) return 0;
    const prefix = waitingPrefixOf(dirPath);
    return reviewWaitingPaths.filter((p) => p.startsWith(prefix)).length;
  };

  // Cloud files the user has queued for removal (from team edit-mode deletes).
  // These get a "Marked for deletion" pill on the Team tab so the pending
  // removal is visible before it's applied/published.
  const queuedDeleteIds = new Set(
    pendingChanges
      .filter((c) => c.kind === 'delete' && c.target_file_id)
      .map((c) => c.target_file_id),
  );
  const countCloudDeletesUnder = (folderPath) => {
    if (!folderPath) return 0;
    const pre = `${folderPath}/`;
    let n = 0;
    for (const f of files) {
      const fp = f.folder_path || '';
      if ((fp === folderPath || fp.startsWith(pre)) && queuedDeleteIds.has(f.id)) n += 1;
    }
    return n;
  };

  const cloudFolders = Array.from(teamSubSet)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((name) => {
      const path = teamCur ? `${teamCur}/${name}` : name;
      const count = countCloudFilesUnder(path);
      // A folder reads as "marked for deletion" only when every file under it
      // is queued for removal (i.e. the whole folder is being deleted).
      const allDeleted = count > 0 && countCloudDeletesUnder(path) === count;
      return { id: `teamfold:${name}`, kind: 'folder', name, sizeLabel: fileCountLabel(count), empty: count === 0, modifiedLabel: '', path, status: allDeleted ? 'deleted' : 'synced' };
    });
  // Team files = the canonical main branch, shown the way an admin sees it:
  // every file as the published (synced) version, EXCEPT files the user has
  // queued for deletion, which carry a "Marked for deletion" pill. Other
  // in-flight state ("Awaiting review" / "Edited") still belongs on the
  // My drafts / Waiting for review tabs.
  const cloudFiles = teamInFolder
    .map((row) => cloudItem(row, queuedDeleteIds.has(row.id) ? 'deleted' : 'synced'))
    .sort((a, b) => a.name.localeCompare(b.name));

  // My drafts / Waiting for review browse the local working folder (Finder-
  // style: folders from the disk listing + files filtered by status). This
  // is where folders show + navigate; the Team tab stays the cloud view.
  const fxLocalFolders = teamLocalMode
    ? browseDirs
      .map((d) => {
        const count = countLocalFilesUnder(d.path);
        return { id: `dir:${d.path}`, kind: 'folder', name: d.name, sizeLabel: fileCountLabel(count), empty: count === 0, modifiedLabel: '', path: d.path, _dir: d };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    : [];
  // Draft files the user has marked for deletion (the My-drafts Delete action).
  // Persisted in `hiddenFiles` (lowercase names). They stay VISIBLE in the
  // drafts grid with a "Marked for deletion" pill; on publish they propose
  // removing the main-branch copy (or are simply dropped if never published).
  const isMarkedDraft = (name) => {
    const lc = (name || '').toLowerCase();
    return lc !== '' && hiddenFiles.has(lc);
  };
  // Marked names that exist on main → synthetic fs delete entries in the shape
  // computeBranchDiff / runCommitFlow expect ({ kind:'delete', cloud, fileId }).
  const markedDraftDeletes = (() => {
    const out = [];
    const seen = new Set();
    for (const lc of hiddenFiles) {
      const fid = sidecar.byFilename.get(lc);
      const cloud = fid ? cloudById.get(fid) : null;
      if (cloud && !seen.has(cloud.id)) { seen.add(cloud.id); out.push({ kind: 'delete', fileId: fid, cloud }); }
    }
    return out;
  })();
  // Effective drafts change set: the filesystem diff minus anything for a
  // marked file (so a marked file reads only as a deletion, never as edited/
  // new), plus the explicit marked deletions. Single source for the drafts
  // count, the publish drawer list, the Removed tab, and the publish snapshot.
  const draftFsDiff = [
    ...branchDiff.filter((it) => !isMarkedDraft(it.local?.name || it.cloud?.name)),
    ...markedDraftDeletes,
  ];

  const fxLocalFiles = teamLocalMode
    ? browseFiles
      .map((lf) => localItem(lf, isMarkedDraft(lf.name) ? 'deleted' : statusForLocal(lf)))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  // Removed tab = DRAFT deletions only (files removed from the user's own
  // working copy, or marked for deletion in My drafts → draftFsDiff). Edit-mode
  // deletions (pendingChanges, made on the Team tab) are NOT drafts — they live
  // on the Team tab as a "Marked for deletion" pill and publish through the
  // edit-mode flow, so they're deliberately excluded here.
  const deletedItems = (() => {
    const out = [];
    const seen = new Set();
    for (const it of draftFsDiff) {
      if (it.kind !== 'delete' || !it.cloud || seen.has(it.cloud.id)) continue;
      seen.add(it.cloud.id); out.push(cloudItem(it.cloud, 'deleted'));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  })();

  const draftsItems = [
    ...unsavedEditFiles.filter((lf) => !isMarkedDraft(lf.name)).map((lf) => localItem(lf, draftStatusFor(lf))),
    ...deletedItems,
  ].sort((a, b) => a.name.localeCompare(b.name));
  const reviewItems = waitingReviewFiles.map((lf) => localItem(lf, 'waiting')).sort((a, b) => a.name.localeCompare(b.name));
  const trashItems = deletedItems;

  const fxCounts = {
    team: cloudFolders.length + cloudFiles.length,
    drafts: draftsItems.length,
    review: reviewItems.length,
    trash: trashItems.length,
  };

  // Branch state → drives the inline pill, status bar, and toolbar CTAs.
  // Drafts-side only (draftFsDiff = the user's working-folder changes +
  // marked-for-deletion files). Edit-mode changes (pendingChanges) are a
  // separate stream surfaced on the Team tab, so they don't light up the
  // "unpublished work" drafts indicator.
  const fxLocalChangeCount = draftFsDiff.length;
  const fxHasOpenOwnReq = (changeRequests || []).some((r) => r.author_id === userId && r.status === 'open');
  // "Behind main" is two independent signals OR'd together:
  //   1. isBehindMain — the version cursor (main_version advanced past the
  //      version I last pulled).
  //   2. missingCount — cloud files that have NO local counterpart.
  // The cursor alone is unreliable: when a release bundles several authors'
  // requests, MY OWN request flipping to approved auto-advances my cursor
  // (BranchContext realtime echo) even though that same release merged the
  // OTHER authors' files, which I don't have on disk. missingCount catches
  // exactly that — it's the unambiguous "main has files I'm missing" signal,
  // and it's what the Get-team-updates pull actually applies.
  const fxMissingFromMain = (syncState?.summary?.missingCount || 0) > 0;
  const fxBehind = isBehindMain || fxMissingFromMain;
  // These three signals are NOT mutually exclusive — a user can be behind
  // main AND have unpublished drafts AND have an open request all at once.
  // The toolbar renders an independent button per active flag (see
  // FilesWorkspace), so the single `state` below is only the dominant label
  // for the status pill.
  const fxHasChanges = fxLocalChangeCount > 0;
  let fxBranchState = 'synced';
  if (fxBehind) fxBranchState = 'behind';
  else if (fxHasChanges) fxBranchState = 'changes';
  else if (fxHasOpenOwnReq) fxBranchState = 'waiting';
  const FX_BRANCH = {
    synced: { title: 'Up to date with team', detail: 'Everyone sees the same files.' },
    changes: { title: 'You have unpublished work', detail: 'Send it to the team for approval.' },
    waiting: { title: 'Waiting for approval', detail: 'Sent — the team will accept or send back.' },
    behind: { title: 'Team has new updates', detail: 'Get the latest to keep working.' },
  };
  const fxBranch = {
    state: fxBranchState,
    title: FX_BRANCH[fxBranchState].title,
    detail: FX_BRANCH[fxBranchState].detail,
    workspaceLabel: '',
    behind: fxBehind,
    hasChanges: fxHasChanges,
    waiting: fxHasOpenOwnReq,
  };

  // Drafts / Waiting browse the local folder (so folders show + navigate);
  // Team is the cloud view; Removed is the flat deletions list.
  const fxBrowsable = teamLocalMode && (filesTab === 'drafts' || filesTab === 'review');

  // Active tab's folders/files.
  let fxFolders = [];
  let fxItems = [];
  if (filesTab === 'team') {
    fxFolders = cloudFolders; fxItems = cloudFiles;
  } else if (fxBrowsable) {
    fxItems = filesTab === 'drafts'
      // My drafts is the whole working folder: every file on disk —
      // committed (synced), uncommitted (new/edited), and in-review
      // (waiting) — each tagged with its status ribbon.
      ? fxLocalFiles
      // Waiting for review: only the files in an open change request.
      : fxLocalFiles.filter((f) => f.status === 'waiting');
    // My drafts mirrors the working folder (show every subfolder). Waiting
    // for review shows only folders that actually contain a waiting file,
    // re-labelled with that count — so no empty folders appear.
    fxFolders = filesTab === 'drafts'
      ? fxLocalFolders
      : fxLocalFolders
        .filter((f) => folderHasWaiting(f.path))
        .map((f) => {
          const count = countWaitingUnder(f.path);
          return { ...f, sizeLabel: fileCountLabel(count), empty: count === 0 };
        });
  } else if (filesTab === 'drafts') {
    fxItems = draftsItems;
  } else if (filesTab === 'review') {
    fxItems = reviewItems;
  } else if (filesTab === 'trash') {
    fxItems = trashItems;
  }

  // Breadcrumb.
  let fxCrumbs;
  let fxCanUp = false;
  if (filesTab === 'team') {
    const segs = mainFolderPath ? mainFolderPath.split('/') : [];
    fxCrumbs = [{ label: selectedProject.name || 'Project', path: '' }, ...segs.map((seg, i) => ({ label: seg, path: segs.slice(0, i + 1).join('/') }))];
    fxCanUp = mainFolderPath !== '';
  } else if (fxBrowsable) {
    fxCrumbs = [
      { label: selectedProject.name || 'Project', path: '__root' },
      ...folderStack.map((seg, i) => ({ label: seg.name, path: `__stack:${i}` })),
    ];
    fxCanUp = folderStack.length > 0;
  } else {
    const sectionLabel = filesTab === 'drafts' ? 'My drafts' : filesTab === 'review' ? 'Waiting for review' : 'Removed';
    fxCrumbs = [{ label: selectedProject.name || 'Project', path: '' }, { label: sectionLabel, path: '__section' }];
  }

  // Draft change list for the publish drawer (id = fileId, used to filter
  // the commit snapshot down to the selected subset).
  // Drafts publish list — the user's local working-folder changes + files
  // marked for deletion (draftFsDiff). Edit-mode changes are intentionally NOT
  // folded in here so publishing drafts never sweeps up Team-tab changes.
  const fxDraftChanges = (() => {
    const out = [];
    const seen = new Set();
    for (const it of draftFsDiff) {
      const fid = it.fileId || it.cloud?.id;
      if (!fid || seen.has(fid)) continue;
      seen.add(fid);
      out.push({ id: fid, name: it.local?.name || it.cloud?.name || 'file', status: it.kind === 'add' ? 'new' : it.kind === 'delete' ? 'deleted' : 'edited' });
    }
    return out;
  })();

  // Edit-mode "Apply" list — the cloud metadata changes queued on the Team tab
  // (pendingChanges / branch_changes). Separate stream from drafts.
  const fxEditChanges = (() => {
    const out = [];
    const seen = new Set();
    for (const c of pendingChanges) {
      const fid = c.target_file_id;
      if (!fid || seen.has(fid)) continue;
      seen.add(fid);
      const name = c.proposed?.name || cloudById.get(fid)?.name || syncState?.rows.get(fid)?.local?.name || 'file';
      out.push({ id: fid, name, status: c.kind === 'delete' ? 'deleted' : 'edited' });
    }
    return out;
  })();

  // ── Workspace action handlers ───────────────────────────────────────
  const fxOpen = (item) => {
    if (item.kind === 'folder') {
      if (fxBrowsable && item._dir) handleEnterFolder(item._dir);
      else if (filesTab === 'team' && item.path != null) setMainFolderPath(item.path);
      return;
    }
    if (item._isCloud) handleOpenCloudFileViewer(item._raw);
    else handleOpenLocalFile(item._raw);
  };
  // Right-click → "Edit": open the file to work on it. Local files hand off
  // to the OS's native editor; cloud files open the in-app viewer (there's
  // no local copy to edit until it's downloaded into drafts).
  const fxEdit = (item) => {
    if (!item || item.kind === 'folder') return;
    if (item._isCloud) handleOpenCloudFileViewer(item._raw);
    else handleOpenLocalFile(item._raw);
  };
  // Breadcrumb / up navigation — local folder stack when browsing, cloud
  // folder path on the cloud-fallback team view.
  const fxCrumbNav = (path) => {
    if (fxBrowsable) {
      if (path === '__root') handleNavigateCrumb(-1);
      else if (typeof path === 'string' && path.startsWith('__stack:')) handleNavigateCrumb(Number(path.slice(8)));
    } else if (filesTab === 'team') {
      setMainFolderPath(path || '');
    }
  };
  const fxUp = () => {
    if (fxBrowsable) {
      handleNavigateCrumb(folderStack.length - 2);
    } else if (filesTab === 'team' && mainFolderPath) {
      const p = mainFolderPath.split('/');
      p.pop();
      setMainFolderPath(p.join('/'));
    }
  };
  const fxDelete = (item) => {
    if (item.kind === 'folder') {
      // Local (on-disk) folder → delete the directory and everything in it.
      if (item._dir) { handleDeleteFolder(item._dir); return; }
      // Team (cloud) folder → queue a removal for every file under its path;
      // applied on the next publish, same as a single cloud-file delete.
      if (filesTab === 'team' && item.path != null) {
        const pre = `${item.path}/`;
        const under = files.filter((f) => {
          const fp = f.folder_path || '';
          return fp === item.path || fp.startsWith(pre);
        });
        under.forEach((f) => queueChange({ kind: 'delete', target_file_id: f.id, proposed: null }));
        if (under.length) {
          notify({ category: 'file', variant: 'success', icon: 'trash', title: 'Folder marked for removal', body: `${under.length} file${under.length === 1 ? '' : 's'} in “${item.name}” will be removed once you publish for review.`, dedupeKey: `fx-delfold:${item.path}` });
        }
      }
      return;
    }
    if (item._isCloud) {
      queueChange({ kind: 'delete', target_file_id: item._raw.id, proposed: null });
      notify({ category: 'file', variant: 'success', icon: 'trash', title: 'Marked for removal', body: `"${item._raw.name}" will be removed once you publish for review.`, dedupeKey: `fx-del:${item._raw.id}` });
    } else {
      handleDeleteLocalCard(item._raw);
    }
  };
  // `newName` is collected by FilesWorkspace's in-app name modal (Electron
  // doesn't support window.prompt, so the prompt-based version silently
  // no-op'd). The handler just applies it.
  const fxRename = async (item, newName) => {
    const trimmed = (newName || '').trim();
    if (!trimmed || trimmed === item.name) return;
    if (item.kind === 'folder') {
      // Only local (on-disk) folders carry a _dir handle; cloud folders are
      // read-only. Renaming the directory re-homes the files inside it, which
      // surfaces as folder-move edits on the next publish.
      if (!item._dir?.name) return;
      handleRenameFolder(item._dir, trimmed);
      return;
    }
    if (item._isCloud) {
      queueChange({ kind: 'edit', target_file_id: item._raw.id, proposed: { name: trimmed } });
      notify({ category: 'file', variant: 'success', icon: 'edit', title: 'Rename queued', body: `Publish for review to apply the new name.`, dedupeKey: `fx-rename:${item._raw.id}` });
    } else if (item._raw.path) {
      const { error } = await localFolderApi.renameFile({ dir: currentDir, fromName: item._raw.name, toName: trimmed });
      if (error) notify({ category: 'file', variant: 'error', title: 'Couldn’t rename', body: error, dedupeKey: 'fx-rename-err' });
      else refetchLocalFiles();
    }
  };
  const fxMove = () => {
    notify({ category: 'file', variant: 'info', title: 'Moving files', body: 'To reorganise files, move them in your connected folder on your computer — changes sync automatically.', dedupeKey: 'fx-move-hint' });
  };
  // Right-click → "Open file location": reveal the on-disk file/folder in
  // the OS file manager. Only meaningful for local items (cloud rows have
  // no path; the menu hides the entry for those).
  const fxOpenLocation = (item) => {
    const p = item?.kind === 'folder' ? item?._dir?.path : item?._raw?.path;
    if (p) localFolderApi.showInFolder(p);
  };
  // `name` comes from FilesWorkspace's in-app name modal (see fxRename note).
  const fxNewFolder = async (name) => {
    if (!localFolder) {
      notify({ category: 'file', variant: 'info', title: 'Connect a folder first', body: 'Choose a folder on your computer, then you can organise it.', dedupeKey: 'fx-newfolder-nofolder' });
      return;
    }
    const trimmed = (name || '').trim();
    if (trimmed) handleCreateFolder(trimmed);
  };
  const fxUpload = () => {
    if (!localFolder) { handleBrowseFolder(); return; }
    localUploadInputRef.current?.click();
  };

  // Publish the selected subset of drafts. Normally this creates change
  // requests that wait for review. When `opts.applyDirect` is set (the Team
  // edit-mode "Apply" flow, admins only) the created requests are immediately
  // approved/merged so the changes land on main without a review round-trip.
  const fxPublish = async (selectedIds, title, note, opts) => {
    if (pushing) return { error: new Error('A publish is already in progress') };
    if (!projectId || !userId) return { error: new Error('No project') };
    const idSet = new Set(selectedIds || []);
    // Two independent change streams: edit-mode (cloud metadata changes queued
    // on the Team tab → pendingChanges) and drafts (local working-folder
    // changes → branchDiff). Each publish flow commits ONLY its own stream, so
    // editing the main branch never sweeps up the user's drafts and vice versa.
    const fromEdit = Boolean(opts?.fromEdit);
    const full = fromEdit
      ? buildCommitSnapshot({ fsDiff: [], pendingChanges })
      : buildCommitSnapshot({ fsDiff: draftFsDiff, pendingChanges: [] });
    const snapshot = idSet.size === 0
      ? full
      : full.filter((it) => idSet.has(it.fileId || it.target_file_id || it.cloud?.id));
    if (snapshot.length === 0) return { error: new Error('Nothing selected to send') };
    const applyDirect = Boolean(opts?.applyDirect) && viewerIsAdmin;
    setPushing(true);
    setPushProgress(null);
    try {
      const dateStr = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const { data: pushData, error: pushErr } = await runCommitFlow({
        projectId,
        userId,
        snapshot,
        title: title || `Changes — ${dateStr}`,
        description: note || '',
        onProgress: ({ current, total }) => setPushProgress({ current, total }),
      });
      if (pushErr) {
        notify({ category: 'file', variant: 'error', title: 'Could not send', body: pushErr.message || String(pushErr), dedupeKey: `fx-push-fail:${Date.now()}` });
        return { error: pushErr };
      }
      if (applyDirect) {
        // Merge the just-created requests straight into main. approveRelease
        // fires its own success/error toast ("merged into main").
        const reqIds = (pushData?.requests || []).map((r) => r?.id).filter(Boolean);
        const { error: appErr } = await approveRelease(reqIds);
        await refreshBranchState?.();
        await refreshOpenRequestItems?.();
        if (appErr) {
          // Push succeeded but the merge didn't — the request already exists,
          // so route it to review (a safe fallback) and close the drawer
          // rather than risk a duplicate submit. Report success so the drawer
          // resets; the warning toast explains where the changes went.
          notify({ category: 'file', variant: 'warning', title: 'Saved to review instead', body: 'Your changes couldn’t be applied directly, so they’re waiting in review.', dedupeKey: `fx-apply-fallback:${Date.now()}` });
          setFilesTab('review');
        }
        return { error: null };
      }
      await refreshOpenRequestItems?.();
      notify({ category: 'file', variant: 'success', icon: 'check', title: 'Sent for review', body: 'Your team will see these changes and approve or send them back.', dedupeKey: `fx-push-ok:${Date.now()}` });
      setFilesTab('review');
      return { error: null };
    } finally {
      setPushing(false);
      setPushProgress(null);
    }
  };

  // Revert team-edit-mode changes: discard every queued metadata change
  // (the rename / delete edits made while in edit mode). Confirmed because
  // it's destructive. Local file additions on disk aren't touched.
  const fxRevertEdits = async () => {
    if (pendingChanges.length === 0) return;
    // No OS confirm — Revert is a deliberate button press; discard directly.
    await discardAll();
    notify({ category: 'file', variant: 'success', icon: 'check', title: 'Edits reverted', body: 'Your unpublished changes were discarded.', dedupeKey: 'fx-revert-edits' });
  };

  // Header count = ALL the user's files: the full local working-folder
  // listing when a folder is connected (committed + uncommitted + in-review),
  // otherwise the cloud/team file count (e.g. viewers with no local folder).
  const fxTotalFiles = teamLocalMode ? localFiles.length : files.length;

  const filesWorkspaceProps = {
    projectName: selectedProject.name,
    summaryText: `${fxTotalFiles} ${fxTotalFiles === 1 ? 'file' : 'files'}`,
    tab: filesTab,
    onTabChange: setFilesTab,
    counts: fxCounts,
    draftDot: fxCounts.drafts > 0,
    branch: fxBranch,
    canEdit: viewerIsMember || viewerIsAdmin,
    isAdmin: viewerIsAdmin,
    hasLocalFolder: Boolean(localFolder),
    onPickFolder: handleBrowseFolder,
    hasLocalFolderApi,
    localFolder,
    onFolderChange: setLocalFolder,
    folderEditable: isElectronBranch,
    crumbs: fxCrumbs,
    onCrumb: fxCrumbNav,
    onBack: fxUp,
    onUp: fxUp,
    canBack: fxCanUp,
    canUp: fxCanUp,
    folders: fxFolders,
    items: fxItems,
    loading: filesTab === 'team' ? loading : false,
    onOpen: fxOpen,
    onEdit: fxEdit,
    onRename: fxRename,
    onMove: fxMove,
    onOpenLocation: fxOpenLocation,
    onDelete: fxDelete,
    onNewFolder: fxNewFolder,
    onUpload: fxUpload,
    onGetUpdates: () => setSyncModalOpen(true),
    draftChanges: fxDraftChanges,
    editChanges: fxEditChanges,
    adminNames: null,
    publishing: pushing,
    publishProgress: pushProgress,
    onPublish: fxPublish,
    onRevertEdits: fxRevertEdits,
  };

  const fxSyncModalEl = (
    <SyncToMainModal
      open={syncModalOpen}
      onClose={() => setSyncModalOpen(false)}
      snapshot={syncState?.toSync || []}
      localFolder={localFolder}
      onSyncComplete={({ syncedHashes, deletedNames, syncedFileIds }) => {
        setLocalHashByName((prev) => {
          const next = new Map(prev);
          for (const [name, hash] of syncedHashes) next.set(name, hash);
          for (const name of deletedNames) next.delete(name);
          return next;
        });
        setSidecar((prev) => {
          let next = prev;
          for (const [filename, fileId] of (syncedFileIds || new Map())) {
            next = addSidecarEntry(next, fileId, { filename, contentHash: syncedHashes.get(filename) || null, mtime: new Date().toISOString() });
          }
          if (next !== prev) saveSidecar(next);
          return next;
        });
      }}
      onLocalListChanged={async () => {
        if (!hasLocalFolderApi || !localFolder) return;
        const { files: localList, error: listErr } = await localFolderApi.listAll(localFolder);
        if (!listErr) setLocalFiles(localList || []);
      }}
    />
  );

  return (
    <div className="project-scoped-page project-files-page fx-root" ref={pageRef}>
      <FilesWorkspace {...filesWorkspaceProps} />
      <input
        ref={localUploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleLocalFilesPicked}
      />
      {fxSyncModalEl}
    </div>
  );
}
