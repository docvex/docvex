import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useBranch } from '../../context/BranchContext';
import { useAuth } from '../../context/AuthContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import SyncToMainModal from '../../components/SyncToMainModal';
import { runCommitFlow, buildCommitSnapshot } from '../../lib/commitFlow';
import FileThumbnail from '../../components/FileThumbnail';
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
import { openFileWindow, openDocx, canOpenInApp, canViewInBrowser, isDocxFile } from '../../lib/platform';
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
        draggable={Boolean(canMove && file?.path)}
        onDragStart={canMove && file?.path ? (e) => {
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
        </div>
        <div className="project-files-meta">
          <div className="project-files-name">{base || file.name}</div>
        </div>
      </div>
      {modified && (
        <span className="project-files-modified-pill" aria-label="Local changes">
          Modified
        </span>
      )}
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
  const [browseFiles, setBrowseFiles] = useState([]);
  const [browseDirs, setBrowseDirs] = useState([]);
  const [browseTick, setBrowseTick] = useState(0);
  const [creatingFolder, setCreatingFolder] = useState(false);
  // Right-click-the-background menu (My branch): { x, y } | null.
  const [bgMenu, setBgMenu] = useState(null);
  const atRoot = folderStack.length === 0;
  const currentDir = atRoot ? localFolder : folderStack[folderStack.length - 1].path;
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
  }, [projectId, localFolder]);
  useEffect(() => { setMainFolderPath(''); }, [projectId]);

  // Browse listing — drives the displayed grid for the CURRENT directory
  // (root or a descended subfolder). Kept separate from `localFiles`
  // (the root listing the branch sync diffs against) so navigating into
  // a subfolder can't make the sync think every root file was deleted.
  useEffect(() => {
    if (branchView !== 'mine' || !supportsFolders || !localFolder) {
      setBrowseFiles([]);
      setBrowseDirs([]);
      return undefined;
    }
    let cancelled = false;
    localFolderApi.list(currentDir).then(({ files: bf, dirs: bd }) => {
      if (cancelled) return;
      setBrowseFiles(bf || []);
      setBrowseDirs(bd || []);
    }).catch(() => {
      if (!cancelled) { setBrowseFiles([]); setBrowseDirs([]); }
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
      openDocx({ cloudUrl: data.signedUrl, fileName: file.name || 'file' });
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

  // Double-click on a local card. Lives down here (after the
  // `cloudById` declaration) instead of up with the other handlers
  // because the DOCX branch needs `cloudById` to look up the cloud
  // counterpart via the sidecar — referencing it earlier hits the
  // temporal dead zone.
  //   • DOCX        → openDocx with both the local path and a signed
  //                   cloud URL (when a cloud counterpart exists),
  //                   so main can pick the best renderer: Word for
  //                   the local file, Office Online for the cloud
  //                   URL when Word isn't installed, OS-default as
  //                   a last resort.
  //   • Browser-viewable (image/video/PDF/text) → in-app BrowserWindow
  //                   via `localfile://`.
  //   • Anything else → OS default app via shell.openPath.
  const handleOpenLocalFile = useCallback(async (file) => {
    if (!hasLocalFolderApi || !file?.path) return;
    if (isDocxFile(file.mimeType, file.name)) {
      const lcName = (file.name || '').toLowerCase();
      const cloudId = sidecar.byFilename.get(lcName);
      const cloud = cloudId ? cloudById.get(cloudId) : null;
      let cloudUrl = null;
      if (cloud?.storage_path) {
        // 1800 s TTL — see handleOpenCloudFileViewer for rationale.
        const { data } = await createSignedDownloadUrl(cloud.storage_path, 1800);
        cloudUrl = data?.signedUrl || null;
      }
      openDocx({ localPath: file.path, cloudUrl, fileName: file.name || 'file' });
      return;
    }
    if (canViewInBrowser(file.mimeType, file.name)) {
      const isWebPath = typeof file.path === 'string' && file.path.startsWith('web://');
      if (!isWebPath) {
        // Mtime as cache-buster keeps an in-place edit from serving
        // the old bytes the OS may have cached at the same URL.
        const suffix = file.mtimeIso ? `?t=${encodeURIComponent(file.mtimeIso)}` : '';
        const url = `localfile://local/${encodeURIComponent(file.path)}${suffix}`;
        openFileWindow(url, file.name || 'file');
        return;
      }
    }
    localFolderApi.openPath(file.path);
  }, [sidecar, cloudById]);

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
      title: 'File hidden',
      body: `"${localFile.name}" is hidden from your view. The file stays on disk.`,
      dedupeKey: `hide-local-ok:${localFile.path}`,
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
        {/* Version readout. Lives under the folder input so the user
            sees, at a glance, which main-branch snapshot their local
            folder is tracking against the project's current main.
            main bumps server-side every time approve_change_request
            runs; local (= branch.base_version) bumps when the user
            pulls main via SyncToMainModal. A mismatch lights up the
            "New main branch available" chip above. */}
        {hasLocalFolderApi && (
          <p className="project-files-main-version">
            Main <strong>v{mainVersion ?? 0}</strong>
            <span className="project-files-main-version-sep" aria-hidden="true">·</span>
            Local <strong>v{branchState?.base_version ?? 0}</strong>
          </p>
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
                  edits waiting for approval
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
                    : 'Pull the new main branch into your folder'
                }
              >
                <span className="project-files-branch-status-dot" aria-hidden="true" />
                <div className="project-files-branch-status-text">
                  <strong className="project-files-branch-status-label">New main branch available</strong>
                  <p className="project-files-branch-status-sub">
                    {!hasLocalFolderApi || !localFolder
                      ? 'Pick a folder above so we can save the new branch there.'
                      : 'A new version of main was published. Click to pull it into your folder.'}
                  </p>
                </div>
                <span className="project-files-branch-status-cta" aria-hidden="true">Pull →</span>
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
        // Right-click the empty background → "Make new folder" / "Import".
        onContextMenu={handleBgContextMenu}
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
            // Folder-aware cloud view. Files carry a folder_path; show
            // only those in the current folder, plus the immediate
            // subfolders under it (derived from every file's path).
            const cur = mainFolderPath;
            const prefix = cur ? `${cur}/` : '';
            const inFolder = files.filter((f) => (f.folder_path || '') === cur);
            const subSet = new Set();
            for (const f of files) {
              const fp = f.folder_path || '';
              if (cur === '') {
                if (fp) subSet.add(fp.split('/')[0]);
              } else if (fp.startsWith(prefix)) {
                subSet.add(fp.slice(prefix.length).split('/')[0]);
              }
            }
            const subfolders = Array.from(subSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            const crumbs = cur ? cur.split('/') : [];
            const buckets = bucketFiles(inFolder, 'mime_type');
            return (
              <>
                {(crumbs.length > 0 || subfolders.length > 0) && (
                  <div className="project-files-folderbar">
                    <nav className="project-files-breadcrumb" aria-label="Folder path">
                      <button
                        type="button"
                        className={`project-files-crumb${cur === '' ? ' is-current' : ''}`}
                        onClick={() => setMainFolderPath('')}
                      >
                        All files
                      </button>
                      {crumbs.map((seg, i) => (
                        <React.Fragment key={i}>
                          <span className="project-files-crumb-sep" aria-hidden="true">/</span>
                          <button
                            type="button"
                            className={`project-files-crumb${i === crumbs.length - 1 ? ' is-current' : ''}`}
                            onClick={() => setMainFolderPath(crumbs.slice(0, i + 1).join('/'))}
                            title={seg}
                          >
                            {seg}
                          </button>
                        </React.Fragment>
                      ))}
                    </nav>
                  </div>
                )}
                {subfolders.length > 0 && (
                  <section className="project-files-section">
                    <h3 className="project-files-section-title">
                      Folders
                      <span className="project-files-section-count">{subfolders.length}</span>
                    </h3>
                    <div className="project-files-grid">
                      {subfolders.map((fname) => {
                        const go = () => setMainFolderPath(cur ? `${cur}/${fname}` : fname);
                        return (
                          <div key={fname} className="project-files-local-card-wrap">
                            <div
                              role="button"
                              tabIndex={0}
                              className="project-files-card project-files-folder-card"
                              // Open on double-click only; Enter is the
                              // keyboard equivalent.
                              onClick={(e) => { e.stopPropagation(); }}
                              onDoubleClick={(e) => { e.stopPropagation(); go(); }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); go(); }
                              }}
                            >
                              <div className="project-files-thumb project-files-folder-thumb">
                                <span className="project-files-folder-icon">{FolderGlyphFilled}</span>
                              </div>
                              <div className="project-files-meta">
                                <div className="project-files-name" title={fname}>{fname}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
                {inFolder.length === 0 && subfolders.length === 0 ? (
                  <div className="project-files-empty">
                    <h2>This folder is empty</h2>
                  </div>
                ) : FILE_SECTIONS.map(({ key, title }) => {
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
                            onDoubleOpen={handleOpenCloudFileViewer}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </>
            );
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
                {/* Show-hidden affordance — only appears when there's
                    anything to unhide. Clears the entire hidden set in
                    one click; granular per-file unhiding lives outside
                    the scope of the current iteration. */}
                {hiddenFiles.size > 0 && (
                  <button
                    type="button"
                    className="project-files-scope-btn project-files-scope-show-hidden"
                    onClick={showAllHidden}
                    title={`${hiddenFiles.size} hidden file${hiddenFiles.size === 1 ? '' : 's'}. Click to show ${hiddenFiles.size === 1 ? 'it' : 'them all'} again.`}
                  >
                    Show {hiddenFiles.size} hidden
                  </button>
                )}
              </div>
              {/* Folder breadcrumb — Electron only, shown once you've
                  navigated into a folder (or any exist). Each crumb is a
                  drop target so a dragged file can be moved up to that
                  level. Creating folders / importing now lives in the
                  right-click-the-background menu. */}
              {supportsFolders && (!atRoot || browseDirs.length > 0) && (
                <div className="project-files-folderbar">
                  <nav className="project-files-breadcrumb" aria-label="Folder path">
                    <button
                      type="button"
                      className={`project-files-crumb${atRoot ? ' is-current' : ''}`}
                      onClick={() => handleNavigateCrumb(-1)}
                      onDragOver={(e) => { if (Array.from(e.dataTransfer.types || []).includes(MOVE_DND_TYPE)) { e.preventDefault(); } }}
                      onDrop={(e) => { const p = e.dataTransfer.getData(MOVE_DND_TYPE); if (p) { e.preventDefault(); handleMoveLocalFile(p, localFolder); } }}
                    >
                      {(localFolder || '').split(/[\\/]/).filter(Boolean).pop() || 'Home'}
                    </button>
                    {folderStack.map((seg, i) => (
                      <React.Fragment key={seg.path}>
                        <span className="project-files-crumb-sep" aria-hidden="true">/</span>
                        <button
                          type="button"
                          className={`project-files-crumb${i === folderStack.length - 1 ? ' is-current' : ''}`}
                          onClick={() => handleNavigateCrumb(i)}
                          onDragOver={(e) => { if (Array.from(e.dataTransfer.types || []).includes(MOVE_DND_TYPE)) { e.preventDefault(); } }}
                          onDrop={(e) => { const p = e.dataTransfer.getData(MOVE_DND_TYPE); if (p) { e.preventDefault(); handleMoveLocalFile(p, seg.path); } }}
                          title={seg.name}
                        >
                          {seg.name}
                        </button>
                      </React.Fragment>
                    ))}
                  </nav>
                </div>
              )}
              {/* Folders category — subfolders of the current directory,
                  plus the inline create-folder tile when active. */}
              {supportsFolders && (browseDirs.length > 0 || creatingFolder) && (
                <section className="project-files-section">
                  <h3 className="project-files-section-title">
                    Folders
                    <span className="project-files-section-count">{browseDirs.length}</span>
                  </h3>
                  <div className="project-files-grid">
                    {creatingFolder && (
                      <NewFolderInput
                        onCommit={handleCreateFolder}
                        onCancel={() => setCreatingFolder(false)}
                      />
                    )}
                    {browseDirs.map((dir) => (
                      <LocalFolderCard
                        key={dir.path}
                        dir={dir}
                        onOpen={handleEnterFolder}
                        onRename={handleRenameFolder}
                        onDelete={handleDeleteFolder}
                        onMoveFile={handleMoveLocalFile}
                      />
                    ))}
                  </div>
                </section>
              )}
              {(() => {
            // Bucket every disk file as a local card, then (when scope
            // == 'all') add ghost "missing" cards for cloud rows that
            // syncState couldn't link to a local file. The unified
            // syncState already classified every fileId; here we just
            // pluck the missing-local entries and surface them with
            // the download overlay. `dispFiles` is the CURRENT directory's
            // files (root or subfolder) on Electron, falling back to the
            // flat root listing on web (no folder navigation there).
            const dispFiles = supportsFolders ? browseFiles : localFiles;
            const buckets = { photos: [], videos: [], documents: [] };
            const localByLcName = new Map();
            for (const lf of dispFiles) {
              if (lf?.name) localByLcName.set(lf.name.toLowerCase(), lf);
            }
            for (const f of dispFiles) {
              // Skip filenames the user hid via the morph-pill's Hide
              // action. Pure presentation filter — the file is still
              // on disk and still in localByLcName above, so the
              // missing-local fallback below still sees it (and
              // suppresses any ghost "download" card that would
              // otherwise re-surface the hidden file under a different
              // path). The hidden set stays in localStorage; the chip
              // near the scope toggle exposes Show all.
              if (hiddenFiles.has(f.name.toLowerCase())) continue;
              buckets[categorizeMime(f.mimeType)].push({ kind: 'local', file: f });
            }
            // "Missing — download" ghosts are a ROOT concept (the cloud
            // is flat). Don't surface them while browsing a subfolder.
            if (atRoot && myBranchScope === 'all' && syncState) {
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
                // Also suppress when the cloud row's name matches a
                // hidden filename — otherwise hiding a cloud-backed
                // file would just relabel the card from "local" to
                // "missing — download", which defeats the hide.
                if (cloudLcName && hiddenFiles.has(cloudLcName)) continue;
                if (storageFilename && hiddenFiles.has(storageFilename)) continue;
                buckets[categorizeMime(row.cloud.mime_type)].push({
                  kind: 'missing',
                  file: row.cloud,
                });
              }
            }
            const totalItems = buckets.photos.length + buckets.videos.length + buckets.documents.length;
            if (totalItems === 0) {
              // Folders (if any) already render in the section above, so
              // suppress the "empty" message when this dir has subfolders
              // or the create-folder tile is open.
              if (supportsFolders && (browseDirs.length > 0 || creatingFolder)) return null;
              // Inside a subfolder there's no cloud to sync — keep it simple.
              if (!atRoot) {
                return (
                  <div className="project-files-empty">
                    <h2>This folder is empty</h2>
                    <p>Drag files here or use the + button to add some.</p>
                  </div>
                );
              }
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
                            onClick={(file) => handleDownloadOne(file)}
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
                      // Folders sync to the team now, so a subfolder file
                      // maps to its cloud row by (unique) filename just
                      // like a root file. The folder it lives in is
                      // metadata on the row (folder_path); a mismatch
                      // surfaces as a pending move in the diff.
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
          const { files: localList, error: listErr } = await localFolderApi.listAll(localFolder);
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

      {/* Right-click-the-background menu (My branch). Portalled to body
          so it escapes the panel's overflow; positioned at the cursor
          (clamped to the viewport). onMouseDown stops the window
          dismiss from closing it before an item's click fires. */}
      {bgMenu && createPortal(
        <div
          className="project-files-bg-menu"
          role="menu"
          style={{
            left: Math.min(bgMenu.x, window.innerWidth - 200),
            top: Math.min(bgMenu.y, window.innerHeight - 96),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="project-files-bg-menu-item"
            onClick={() => { setBgMenu(null); setCreatingFolder(true); }}
          >
            Make new folder
          </button>
          <button
            type="button"
            role="menuitem"
            className="project-files-bg-menu-item"
            onClick={() => { setBgMenu(null); localUploadInputRef.current?.click(); }}
          >
            Import
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
