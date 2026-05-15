import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
import FileDetailModal from '../../components/FileDetailModal';
import VideoFrameSlideshow from '../../components/VideoFrameSlideshow';
import Tooltip from '../../components/Tooltip';
import {
  listProjectFiles,
  createSignedDownloadUrl,
  subscribeForProject,
} from '../../lib/projectFiles';
import './ProjectScoped.css';
import './ProjectFiles.css';

// Project-scoped file list. Uploads come in via the global drag-drop
// overlay (UploadOverlay + UploadsContext) — this page doesn't own the
// upload pipeline, it only reads the result. The Realtime subscription
// on `project_files` makes new uploads appear here without an explicit
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

function iconForMime(mime) {
  if (!mime) return GenericFileIcon;
  if (mime === 'application/pdf') return PdfIcon;
  if (mime.startsWith('video/')) return VideoIcon;
  if (mime.startsWith('text/')) return TextIcon;
  return GenericFileIcon;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
      </div>
        <div className="project-files-meta">
          <div className="project-files-name">{file.name}</div>
          <div className="project-files-sub">
            {formatBytes(file.size_bytes)} · {formatDate(file.uploaded_at)}
          </div>
        </div>
      </button>
    </Tooltip>
  );
}

// Per-project file count cached in localStorage so the next visit's
// skeleton matches what the user is about to see (zero layout shift on
// hand-off). The cache is written after every successful list load —
// see the effect in ProjectFiles below. On first-ever visit the read
// returns null and the skeleton falls back to a small default count.
const FILES_COUNT_KEY = (projectId) => `docvex:project-files-count:${projectId}`;
const DEFAULT_SKELETON_COUNT = 8;

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

  return (
    <div className="project-scoped-page">
      <header className="project-scoped-header">
        <h1 className="project-scoped-title">Files</h1>
        <p className="project-scoped-subtitle">
          Drop files anywhere in the app to upload to <strong>{selectedProject.name}</strong>.
        </p>
      </header>

      {error && (
        <div className="project-files-error" role="alert">{error}</div>
      )}

      {loading ? (
        <ProjectFilesGridSkeleton count={readCachedFilesCount(projectId)} />
      ) : files.length === 0 ? (
        <div className="project-files-empty">
          <h2>No files yet</h2>
          <p>Drag a PDF, image, video, or text document anywhere in the app to upload it here.</p>
        </div>
      ) : (
        <div className="project-files-grid">
          {files.map((f) => (
            <FileCard key={f.id} file={f} onOpen={(file) => setOpenFileId(file.id)} />
          ))}
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
    </div>
  );
}
