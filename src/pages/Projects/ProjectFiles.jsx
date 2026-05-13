import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import ProjectScopedSkeleton from '../../components/ProjectScopedSkeleton';
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

// One file card. Images fetch a signed URL lazily on mount to render a
// thumbnail; non-images render the MIME glyph. Click anywhere on the
// card → open the file via a fresh signed URL in a new window/tab.
function FileCard({ file }) {
  const isImage = (file.mime_type || '').startsWith('image/');
  const [thumbUrl, setThumbUrl] = useState(null);
  const [opening, setOpening] = useState(false);

  // Lazy signed-URL fetch for image thumbnails. Cancellation flag so a
  // fast project switch + remount doesn't write stale URLs into the
  // new card's state.
  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    createSignedDownloadUrl(file.storage_path, 300).then(({ data, error }) => {
      if (cancelled || error || !data?.signedUrl) return;
      setThumbUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [isImage, file.storage_path]);

  // Fresh signed URL on click — the thumb URL is 5 min and might have
  // expired by the time the user clicks, and a non-image card never
  // fetched one to begin with. Either way, one extra round-trip is
  // imperceptible.
  const handleOpen = async () => {
    if (opening) return;
    setOpening(true);
    const { data, error } = await createSignedDownloadUrl(file.storage_path, 300);
    setOpening(false);
    if (error || !data?.signedUrl) return;
    // In Electron, window.open with http(s) URLs is allowed by main.js's
    // app:open-external filter for clicked NavLinks. createSignedUrl
    // returns an https:// URL, so this is fine in both Electron renderer
    // and the web build.
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <button
      type="button"
      className="project-files-card"
      onClick={handleOpen}
      title={file.name}
    >
      <div className="project-files-thumb">
        {isImage && thumbUrl ? (
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
  );
}

export default function ProjectFiles() {
  const { selectedProject, loading: projLoading } = useSelectedProject();
  const projectId = selectedProject?.id || null;

  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
        <div className="project-files-loading">Loading files…</div>
      ) : files.length === 0 ? (
        <div className="project-files-empty">
          <h2>No files yet</h2>
          <p>Drag a PDF, image, video, or text document anywhere in the app to upload it here.</p>
        </div>
      ) : (
        <div className="project-files-grid">
          {files.map((f) => <FileCard key={f.id} file={f} />)}
        </div>
      )}
    </div>
  );
}
