import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBranch } from '../context/BranchContext';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import {
  listOpenChangeRequestItemsForProject,
  subscribeChangeRequestItemsForProject,
  createPendingSignedUrl,
} from '../lib/branches';
import {
  fetchUploaderProfile,
  listProjectFiles,
} from '../lib/projectFiles';
import FileThumbnail from './FileThumbnail';
import FileDetailModal from './FileDetailModal';
import Tooltip from './Tooltip';
import { describeChangeRequestItem } from '../lib/thumbnailDescriptor';
import './ChangeRequestsView.css';

// "Compose release" surface — embedded inside the Project Dashboard's
// "Version control" tab. Three panes:
//   • Files with changes  (top-left)
//   • Versions of the selected file from each team member (bottom-left)
//   • New release composition area (right) — drag a version from the
//     versions pane into here to include it.
//
// Drag-and-drop model: one staged version per file (dragging a second
// version of the same file replaces the staged one — matches the "one
// canonical version per file in the next release" mental model).
//
// Approve action: collects the unique source request_ids of every
// staged version and approves each via the existing per-request
// approve RPC. The current backend approves a whole request at a time;
// partial selections from a request will still pull in the request's
// other items. A warning surfaces this when it applies.

const KIND_LABEL = {
  add:     'Add',
  edit:    'Edit',
  delete:  'Delete',
  replace: 'Replace',
};

// File identity for grouping versions across requests. target_file_id
// is the natural key for edit/replace/delete; adds don't have a cloud
// row yet, so we key by their proposed filename instead (lower-cased
// for Windows-style case-insensitive matching).
function fileKeyFor(item) {
  if (item.target_file_id) return `f:${item.target_file_id}`;
  if (item.kind === 'add' && item.proposed?.name) return `a:${item.proposed.name.toLowerCase()}`;
  return `x:${item.id}`;
}

// Stable display name for a file group. For adds: the first version's
// proposed.name is THE name. For edit/replace/delete targets: prefer
// the cloud row's current name (reflects prior approved renames);
// fall back to a version's proposed.name when the cloud row hasn't
// arrived yet (realtime race) or is missing entirely.
function fileDisplayName(group, cloudFilesById) {
  if (!group.fileId) {
    return group.versions[0]?.item?.proposed?.name || 'unnamed';
  }
  const cf = cloudFilesById.get(group.fileId);
  if (cf?.name) return cf.name;
  for (const v of group.versions) {
    if (v.item?.proposed?.name) return v.item.proposed.name;
  }
  return `file ${group.fileId.slice(0, 8)}`;
}

function authorDisplayName(profile) {
  if (!profile) return 'Unknown';
  return profile.full_name || profile.name || profile.email || 'Unknown';
}

// Local copy — every place that shows file sizes in the UI uses the
// same units (B / KB / MB). Inlining the formatter keeps this
// component self-contained vs reaching into FileCard's helper.
function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Build the `file` row to hand to <FileDetailModal> when the user
// clicks an avatar in the compose view. The modal is the same one
// the Files page uses for its detail view — reusing it gives the
// version inspector the same fields, preview, and metadata layout
// the user already knows from there.
//
// For items with a target_file_id we OVERLAY proposed.* on top of
// the cloud row, so the modal reflects what THIS author submitted
// (their name, their description) rather than main's current value.
// uploaded_by is also pinned to the version's author so the modal's
// "By" line credits the right person.
//
// For pure adds there's no cloud row yet — we synthesize one from
// proposed.*. The synthetic row's storage_path is intentionally
// empty: the proposed bytes live in the pending bucket, which
// FileDetailModal's preview pipeline can't sign (it's wired to the
// canonical 'projects' bucket). The modal falls back to the MIME
// glyph; the version's metadata still renders correctly.
function buildVersionFile(version, cloudFilesById) {
  const v = version.item;
  const proposed = v.proposed || {};
  const cloud = v.target_file_id ? cloudFilesById.get(v.target_file_id) : null;
  if (cloud) {
    return {
      ...cloud,
      name: proposed.name ?? cloud.name,
      description: proposed.description ?? cloud.description,
      mime_type: proposed.mime_type || cloud.mime_type,
      size_bytes: proposed.size_bytes ?? cloud.size_bytes,
      content_hash: proposed.content_hash || cloud.content_hash,
      // storage_path stays the cloud's canonical path so the
      // preview pane works for edit/delete (which don't touch
      // bytes); replace items will show the OLD bytes since the
      // NEW ones live in the pending bucket (see note above).
      uploaded_by: version.authorId,
    };
  }
  return {
    id: `version-${v.id}`,
    project_id: null,
    name: proposed.name || '(unnamed)',
    description: proposed.description || null,
    mime_type: proposed.mime_type || 'application/octet-stream',
    size_bytes: proposed.size_bytes ?? 0,
    storage_path: '',
    thumbnail_path: null,
    thumbnail_frames: null,
    duration_seconds: null,
    content_hash: proposed.content_hash || null,
    uploaded_by: version.authorId,
    uploaded_at: new Date().toISOString(),
  };
}

// Deterministic author-color picker — feeds the colored dot on every
// version chip and every staged item so the reviewer can scan "whose
// version is whose" at a glance without reading any names. A user's
// dot is the same color everywhere they appear in this view.
//
// Palette is high-saturation primaries + secondaries that read well
// against the dark UI; ~12 entries keeps collisions rare in
// realistic team sizes (and a collision is visually identical to the
// avatar fallback initials — recoverable, not catastrophic).
const AUTHOR_COLORS = [
  '#22c55e', // green
  '#ef4444', // red
  '#a855f7', // purple
  '#facc15', // yellow
  '#3b82f6', // blue
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#84cc16', // lime
  '#f43f5e', // rose
];
function authorColor(authorId) {
  if (!authorId) return AUTHOR_COLORS[0];
  // djb2-ish hash — small, deterministic, no dependencies.
  let h = 0;
  for (let i = 0; i < authorId.length; i++) {
    h = ((h << 5) - h) + authorId.charCodeAt(i);
    h |= 0;
  }
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length];
}

// Thumbnail container for a change-request item. Build the descriptor
// via describeChangeRequestItem + hand it to the unified Thumbnail —
// same code path the Files page cards use, so a file shows the same
// poster everywhere, the cache hits across surfaces, and any future
// thumbnail improvement (DOCX renderer tweak, new MIME support) lands
// here for free.
//
// `preferPending` flips the descriptor's fallback chain: version chips
// want the AUTHOR's proposed bytes (pending bucket); the file-column
// header wants the canonical main version (cloud bucket).
function CrThumb({ cloud, item, size = 56, preferPending = false, hovered = false }) {
  const descriptor = useMemo(
    () => describeChangeRequestItem({ item, cloud, preferPending }),
    [
      item?.id,
      item?.proposed?.pending_storage_path,
      item?.proposed?.thumbnail_pending_path,
      item?.proposed?.content_hash,
      item?.proposed?.name,
      item?.proposed?.mime_type,
      cloud?.id,
      cloud?.content_hash,
      cloud?.thumbnail_path,
      cloud?.storage_path,
      cloud?.mime_type,
      preferPending,
    ],
  );
  return (
    <span
      className="cr-thumb"
      style={{ width: size, height: size }}
    >
      <FileThumbnail descriptor={descriptor} hovered={hovered} />
    </span>
  );
}

// Small color dot tagging an author. Renders as a bordered circle
// so it stays visible on both light and dark thumbnails. The
// optional `title` is the author's display name for a tooltip.
// Kept for back-compat callers that don't have a profile loaded.
function AuthorDot({ authorId, title, size = 12 }) {
  return (
    <span
      className="cr-author-dot"
      style={{
        background: authorColor(authorId),
        width: size,
        height: size,
      }}
      title={title}
      aria-label={title ? `Author: ${title}` : 'Author'}
    />
  );
}

// Circular author identifier — profile picture when the OAuth
// avatar_url is set, otherwise an initial-letter circle backed by
// the same authorColor() the dots use (so people without pictures
// still have a stable visual identity). Used in the file-block
// versions row AND in the staged row on the right — the same
// person looks the same in both places.
//
// `draggable` + `onDragStart` make the avatar itself the drag
// handle for staging a version. `isStaged` adds a green ring so
// the user sees which version of which file is in the release.
function AuthorAvatar({
  profile,
  authorId,
  size = 36,
  draggable = false,
  onDragStart,
  onClick,
  isStaged = false,
  isFocused = false,
  ariaLabel,
}) {
  const url = profile?.avatar_url;
  const initial = (profile?.full_name || profile?.name || profile?.email || '?')
    .charAt(0)
    .toUpperCase();
  const className = `cr-author-avatar${isStaged ? ' is-staged' : ''}${isFocused ? ' is-focused' : ''}${draggable ? ' is-draggable' : ''}${onClick ? ' is-clickable' : ''}`;
  // Native `title` is omitted on purpose — callers wrap the avatar
  // in the app's <Tooltip> component for the styled cursor pill
  // instead. aria-label still carries the same string for screen
  // readers (Tooltip is purely visual).
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
      }}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e);
        }
      } : undefined}
      aria-label={ariaLabel || 'Author'}
    >
      {url ? (
        <img
          className="cr-author-avatar-img"
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
        />
      ) : (
        <span
          className="cr-author-avatar-fallback"
          style={{ background: authorColor(authorId) }}
        >
          {initial}
        </span>
      )}
    </span>
  );
}


export default function ChangeRequestsView() {
  const { selectedProject } = useSelectedProject();
  const projectId = selectedProject?.id || null;
  const {
    requests,
    isAdmin,
    rejectRequest,
    setView,
    preferredVersions,
    togglePreferredVersion,
  } = useBranch();
  const { session } = useAuth();
  const viewerId = session?.user?.id || null;
  const navigate = useNavigate();

  // Tracks which version chip the cursor is over so its CrThumb can
  // light up the video frame slideshow (same hover-to-preview gesture
  // the Files page cards expose, now also surfaced here so dashboard
  // reviewers get an animated preview for video changes).
  const [hoveredVersionKey, setHoveredVersionKey] = useState(null);
  // Same idea for file column cards — hover lights the slideshow on
  // the top thumbnail too. Files in the column show main's current
  // bytes (preferPending=false), so a video that hasn't changed bytes
  // still cycles its frames here.
  const [hoveredFileKey, setHoveredFileKey] = useState(null);

  // "Push new commit" FAB jumps the user to the Files page on the
  // Yours tab — that's where the actual push button lives (next to
  // the unsaved-edits pill). setView('mine') primes the branch
  // toggle so the Files page lands on the editable surface even if
  // the user previously left it on the Cloud tab.
  const handlePushNewCommit = useCallback(() => {
    setView('mine');
    navigate('/files');
  }, [navigate, setView]);

  // Open the file properties panel from a file card click. Uses the
  // same FileDetailModal the Files page uses, in read-only mode so
  // the review surface doesn't accidentally become an edit surface.
  const [focusedFileId, setFocusedFileId] = useState(null);
  const handleOpenFileGroup = useCallback((group) => {
    if (group?.fileId) setFocusedFileId(group.fileId);
  }, []);

  // Open-only — composing a release only makes sense for proposals
  // that haven't been decided. Past/decided requests would belong on
  // a separate history surface; this tab is single-purpose.
  const openRequests = useMemo(
    () => requests.filter((r) => r.status === 'open'),
    [requests],
  );

  const [allVersions, setAllVersions] = useState([]); // {requestId, requestTitle, authorId, item}
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [authorsById, setAuthorsById] = useState({});
  const [cloudFilesById, setCloudFilesById] = useState(new Map());
  // Bumped imperatively from the items-realtime subscription below
  // (and from the approve handler post-action). The fetch effect
  // listens on it as the canonical "things changed, refetch" pulse;
  // batching here means rapid-fire events (e.g., a teammate's
  // createOrMergeChangeRequest that DELETEs N items then INSERTs N
  // more) collapse into a single fetch.
  const [refreshTick, setRefreshTick] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // Single batched fetch — every open request's items in one round
  // trip via the project_id-scoped query (added in migration 018).
  // Replaces an N+1 of getChangeRequest that would re-fire on every
  // realtime tick once the team got past a handful of open requests.
  useEffect(() => {
    if (!projectId) {
      setAllVersions([]);
      setVersionsLoading(false);
      return undefined;
    }
    let cancelled = false;
    setVersionsLoading(true);
    listOpenChangeRequestItemsForProject(projectId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setAllVersions([]);
      } else {
        // Show every open-request item including the viewer's own.
        // With auto-commit, the user's local edits flow into a real
        // change_request within seconds — they need to be visible
        // here so the user can approve their own work in a single-
        // admin scenario. The earlier "hide own items" filter was
        // wrong: it conflated "raw uncommitted local edits" (which
        // shouldn't appear here) with "auto-committed items in a
        // real review queue" (which absolutely should).
        setAllVersions(data || []);
      }
      setVersionsLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, refreshTick]);

  // Live subscription on change_request_items for this project.
  // Bumps the refresh tick on any event so the fetch effect re-runs
  // and the compose view stays in sync without a manual button —
  // critical for multi-reviewer flows where someone else's push or
  // approve would otherwise leave the screen stale.
  useEffect(() => {
    if (!projectId) return undefined;
    const unsub = subscribeChangeRequestItemsForProject(projectId, () => {
      bumpRefresh();
    });
    return unsub;
  }, [projectId, bumpRefresh]);

  // The parent BranchContext already subscribes to `change_requests`
  // for the project (with my migration 017 widening visibility to
  // members). When a request flips status or a new one lands,
  // `requests` updates → openRequests recomputes → we bump the tick
  // so items refetch too. Without this the items would lag a single
  // realtime cycle behind the request status flip.
  const openRequestIdsKey = useMemo(
    () => openRequests.map((r) => r.id).sort().join('|'),
    [openRequests],
  );
  useEffect(() => {
    bumpRefresh();
  }, [openRequestIdsKey, bumpRefresh]);

  // Fetch cloud file list once per project — gives the canonical
  // display name for edit/replace/delete targets so the file list
  // label matches what the user sees on the Files page.
  useEffect(() => {
    if (!projectId) {
      setCloudFilesById(new Map());
      return undefined;
    }
    let cancelled = false;
    listProjectFiles(projectId).then(({ data }) => {
      if (cancelled) return;
      const m = new Map();
      for (const f of data || []) m.set(f.id, f);
      setCloudFilesById(m);
    });
    return () => { cancelled = true; };
  }, [projectId, refreshTick]);

  // Author profile cache — batch fetch any author ids appearing in
  // the versions list that aren't yet known.
  useEffect(() => {
    const unique = Array.from(new Set(allVersions.map((v) => v.authorId).filter(Boolean)));
    const missing = unique.filter((id) => !(id in authorsById));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map((id) => fetchUploaderProfile(id))).then((results) => {
      if (cancelled) return;
      setAuthorsById((prev) => {
        const next = { ...prev };
        missing.forEach((id, i) => { next[id] = results[i]?.data || null; });
        return next;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allVersions]);

  // Group versions by file identity for the left column. Sorted by
  // display name so the order is predictable across renders.
  const fileGroups = useMemo(() => {
    const groups = new Map();
    for (const version of allVersions) {
      const key = fileKeyFor(version.item);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          fileId: version.item.target_file_id || null,
          versions: [],
        });
      }
      groups.get(key).versions.push(version);
    }
    const arr = Array.from(groups.values());
    arr.sort((a, b) => {
      const na = fileDisplayName(a, cloudFilesById).toLowerCase();
      const nb = fileDisplayName(b, cloudFilesById).toLowerCase();
      return na.localeCompare(nb);
    });
    return arr;
  }, [allVersions, cloudFilesById]);

  // Layout: single tree view (Files → Versions). The previous
  // groupBy toggle (file / author) and the author-grouped list are
  // gone — the horizontal pannable tree replaced both perspectives
  // with one visual, mirroring the dashboard's Members tree.

  // Inspector mode: click an avatar to surface its full version
  // details in the right pane (file metadata, source request,
  // preview link, "stage from inspector" action). The right pane
  // toggles between this and the New Release drop target depending
  // on whether something is focused. `focusedVersion` is the
  // {requestId, item, authorId, requestTitle} snapshot the user
  // clicked; cleared on Close, on drag-start, or when the
  // underlying request goes away.
  const [focusedVersion, setFocusedVersion] = useState(null);
  // Drop the inspector if the focused version's request was just
  // approved / withdrawn / rejected elsewhere — otherwise the user
  // would be staring at metadata for a row that no longer exists.
  useEffect(() => {
    if (!focusedVersion) return;
    const stillThere = allVersions.some(
      (v) => v.requestId === focusedVersion.requestId
        && v.item.id === focusedVersion.item.id,
    );
    if (!stillThere) setFocusedVersion(null);
  }, [focusedVersion, allVersions]);

  // Reviewing a version: View opens the file detail panel (read-
  // only), Decline rejects the source change request. Approve is
  // intentionally not on the card — admins make the merge decision
  // from inside the detail panel where they can see the full
  // proposed content first. Decline is a quick "no" that doesn't
  // need the inspection step, so it stays inline.
  //
  // Decline acts at the REQUEST level (the backend rejects a whole
  // bundle at once); same caveat as the historical "Partial
  // selections" warning — declining one item drops the rest of
  // that author's open bundle too.
  const handleOpenVersion = useCallback((version) => {
    if (version) setFocusedVersion(version);
  }, []);

  // Pre-sign the focused version's pending bytes so the detail
  // panel can render WHAT WAS PROPOSED instead of what currently
  // lives on main. DocxPreview regenerates from these bytes locally
  // (always using the latest renderer) — no separate thumbnail
  // sign is needed; the source bytes are enough.
  const [versionPreviewUrl, setVersionPreviewUrl] = useState(null);
  useEffect(() => {
    setVersionPreviewUrl(null);
    if (!focusedVersion) return undefined;
    const pendingBytes = focusedVersion.item.proposed?.pending_storage_path;
    if (!pendingBytes) return undefined;
    let cancelled = false;
    createPendingSignedUrl(pendingBytes, 600).then(({ data, error }) => {
      if (cancelled || error || !data?.signedUrl) return;
      setVersionPreviewUrl(data.signedUrl);
    });
    return () => { cancelled = true; };
  }, [focusedVersion]);

  // Preferred-version selection state + toggle live in BranchContext
  // (lifted out of this view so picks survive tab switches and any
  // future surfaces that need to read the set get one source of
  // truth). Local alias keeps the call sites short.
  const handleSelectPreferred = togglePreferredVersion;

  const [decliningId, setDecliningId] = useState(null);
  const handleDeclineVersion = useCallback(async (version) => {
    if (!version || !isAdmin) return;
    setDecliningId(version.requestId);
    try {
      const { error } = await rejectRequest(version.requestId);
      if (!error) bumpRefresh();
    } finally {
      setDecliningId(null);
    }
  }, [rejectRequest, isAdmin, bumpRefresh]);

  // ── Tree-pannable canvas state ────────────────────────────────────────
  // Same pattern as TeamTree: fixed viewport fills the area below the
  // tabs, inner container translates on mousedown-drag pan. Geometry
  // recompute fires on layout changes via ResizeObserver so newly
  // arrived versions auto-link.
  const viewportRef = useRef(null);
  const containerRef = useRef(null);
  const fileCardRefs = useRef({});      // key → DOM node
  const versionCardRefs = useRef({});   // `${requestId}:${itemId}` → DOM node
  const [edges, setEdges] = useState([]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef(null);
  const hasCenteredRef = useRef(false);
  const [viewportTop, setViewportTop] = useState(0);

  // Step-shape connector — three legs:
  //   1. Horizontal stub from the file card's right edge to the
  //      midpoint between the two cards.
  //   2. Vertical run at the midpoint, traversing the y delta.
  //   3. Horizontal stub from the midpoint to the version card's
  //      left edge.
  // Two rounded corners (at both bends) keep the visual continuity
  // smooth. Corner radius clamps to half of each leg so short legs
  // never pinch into a misshapen curve.
  const lShape = useCallback((x1, y1, x2, y2) => {
    if (y1 === y2) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const midX = (x1 + x2) / 2;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const halfLeg = Math.abs(midX - x1);
    const r = Math.max(0, Math.min(8, halfLeg / 2, Math.abs(dy) / 2));
    return `M ${x1} ${y1} `
      + `H ${midX - sx * r} `
      + `Q ${midX} ${y1} ${midX} ${y1 + sy * r} `
      + `V ${y2 - sy * r} `
      + `Q ${midX} ${y2} ${midX + sx * r} ${y2} `
      + `H ${x2}`;
  }, []);

  // Measure the bottom of the project-tabs bar — viewport's top edge
  // tracks it so the canvas always starts flush under the tabs.
  useLayoutEffect(() => {
    const measure = () => {
      const tabs = document.querySelector('.project-tabs');
      if (tabs) setViewportTop(tabs.getBoundingClientRect().bottom);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Centre the tree once it has content + a measured viewport.
  useLayoutEffect(() => {
    if (hasCenteredRef.current) return;
    if (viewportTop === 0) return;
    const viewport = viewportRef.current;
    const content = containerRef.current;
    if (!viewport || !content) return;
    if (fileGroups.length === 0) return;
    const cx = (viewport.clientWidth - content.offsetWidth) / 2;
    const cy = (viewport.clientHeight - content.offsetHeight) / 2;
    setPan({ x: cx, y: cy });
    hasCenteredRef.current = true;
  }, [fileGroups, viewportTop]);

  // Mouse-drag panning — listeners on window so the pan keeps
  // tracking even when the cursor leaves the viewport.
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      setPan({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handlePanMouseDown = (e) => {
    // Only start a pan when the click is on the canvas itself, not
    // on a card / button (those have their own handlers). Card
    // interactions stopPropagation in their onClick — for cards
    // without click handlers we still skip the pan if the target
    // sits inside a `.cr-tree-card`.
    if (e.button !== 0) return;
    if (e.target.closest('.cr-tree-card') || e.target.closest('button')) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: pan.x, baseY: pan.y,
    };
    setIsDragging(true);
    e.preventDefault();
  };

  // Recompute SVG paths whenever the file groups change OR card
  // sizes shift. One L-shape per (file, version) pair — file's
  // right edge to that version's left edge. No junction point because
  // the relationship is strictly tree-shaped (each version belongs
  // to exactly one file).
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const recompute = () => {
      const cRect = container.getBoundingClientRect();
      const next = [];
      for (const g of fileGroups) {
        const fileNode = fileCardRefs.current[g.key];
        if (!fileNode) continue;
        const fRect = fileNode.getBoundingClientRect();
        const fx = fRect.right - cRect.left;
        const fy = (fRect.top + fRect.bottom) / 2 - cRect.top;
        for (const v of g.versions) {
          const vKey = `${v.requestId}:${v.item.id}`;
          const vNode = versionCardRefs.current[vKey];
          if (!vNode) continue;
          const vRect = vNode.getBoundingClientRect();
          const vx = vRect.left - cRect.left;
          const vy = (vRect.top + vRect.bottom) / 2 - cRect.top;
          next.push(lShape(fx, fy, vx, vy));
        }
      }
      setEdges(next);
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    for (const node of Object.values(fileCardRefs.current)) {
      if (node) observer.observe(node);
    }
    for (const node of Object.values(versionCardRefs.current)) {
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [fileGroups, lShape]);

  // ── Render ──────────────────────────────────────────────────────────────
  // Horizontal pannable tree, same visual recipe as TeamTree. Two
  // tiers: "Files" on the left, "Edits" on the right. SVG L-shaped
  // edges connect each file to its proposed versions. The user can
  // drag-pan the canvas; cards stay click-targetable because the
  // pan handler bails when the click started on a card or button.
  //
  // Empty / loading states render in-place where the tree would sit
  // so the user gets the same "open the tab, see what's here" feel.
  if (fileGroups.length === 0) {
    return (
      <div
        ref={viewportRef}
        className="cr-tree-viewport"
        style={{ top: `${viewportTop}px` }}
      >
        <div className="cr-tree-empty">
          {versionsLoading ? 'Loading…' : 'No edits waiting for review.'}
        </div>
      </div>
    );
  }
  return (
    <>
    <div
      ref={viewportRef}
      className={`cr-tree-viewport${isDragging ? ' is-dragging' : ''}`}
      onMouseDown={handlePanMouseDown}
      style={{ top: `${viewportTop}px` }}
    >
      <div
        className="cr-tree"
        ref={containerRef}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
      >
        <svg className="cr-tree-edges" aria-hidden="true">
          {edges.map((d, i) => (
            <path key={i} d={d} fill="none" />
          ))}
        </svg>

        {/* Files column */}
        <div className="cr-tree-tier">
          <div className="cr-tree-tier-label">Files with edits</div>
          <div className="cr-tree-tier-cards">
            {fileGroups.map((g) => {
              const name = fileDisplayName(g, cloudFilesById);
              const cloud = g.fileId ? cloudFilesById.get(g.fileId) : null;
              const sizeBytes = cloud?.size_bytes
                ?? g.versions[0]?.item?.proposed?.size_bytes
                ?? null;
              const sizeText = sizeBytes != null ? formatBytes(sizeBytes) : null;
              const meta = [
                sizeText,
                `${g.versions.length} ${g.versions.length === 1 ? 'edit' : 'edits'}`,
              ].filter(Boolean).join(' · ');
              const hasCloud = Boolean(cloud);
              const card = (
                <div
                  key={g.key}
                  ref={(el) => {
                    if (el) fileCardRefs.current[g.key] = el;
                    else delete fileCardRefs.current[g.key];
                  }}
                  className={`cr-tree-card cr-tree-file-card${hasCloud ? ' is-clickable' : ''}`}
                  data-file-key={g.key}
                  onClick={hasCloud ? () => handleOpenFileGroup(g) : undefined}
                  onMouseEnter={() => setHoveredFileKey(g.key)}
                  onMouseLeave={() => setHoveredFileKey((curr) => (curr === g.key ? null : curr))}
                  role={hasCloud ? 'button' : undefined}
                  tabIndex={hasCloud ? 0 : undefined}
                  onKeyDown={hasCloud ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleOpenFileGroup(g);
                    }
                  } : undefined}
                >
                  <CrThumb
                    cloud={cloud}
                    item={g.versions[0]?.item}
                    size={44}
                    preferPending={false}
                    hovered={hoveredFileKey === g.key}
                  />
                  <div className="cr-tree-card-text">
                    <div className="cr-tree-card-name" title={name}>{name}</div>
                    <div className="cr-tree-card-meta">{meta}</div>
                  </div>
                </div>
              );
              return hasCloud
                ? <Tooltip key={g.key} content="Show file properties">{card}</Tooltip>
                : card;
            })}
          </div>
        </div>

        {/* Versions column — one card per (file × author) so the
            connectors map cleanly one-to-one. Cards are ordered to
            match their parent file's vertical position so the SVG
            paths don't cross unnecessarily. */}
        <div className="cr-tree-tier">
          <div className="cr-tree-tier-label">Edits waiting</div>
          <div className="cr-tree-tier-cards">
            {fileGroups.flatMap((g) => g.versions.map((v) => {
              const author = authorsById[v.authorId];
              const authorName = authorDisplayName(author);
              const isAuthorViewer = v.authorId === viewerId;
              const cloud = v.item.target_file_id
                ? cloudFilesById.get(v.item.target_file_id)
                : null;
              const proposedName = v.item.proposed?.name;
              const showRename = v.item.kind === 'edit' && proposedName
                && cloud?.name && cloud.name !== proposedName;
              const kindText = showRename
                ? `Rename to "${proposedName}"`
                : (KIND_LABEL[v.item.kind] || v.item.kind);
              // File display name + size — what to show in the file
              // row sitting under the author. For renames we surface
              // the NEW (proposed) name; otherwise the canonical one.
              const fileDisplay = proposedName
                || cloud?.name
                || ((v.item.proposed?.storage_path || '').split('/').pop())
                || '(file)';
              const fileSizeBytes = v.item.proposed?.size_bytes ?? cloud?.size_bytes ?? null;
              const fileSize = fileSizeBytes != null ? formatBytes(fileSizeBytes) : null;
              const vKey = `${v.requestId}:${v.item.id}`;
              const isDeclining = decliningId === v.requestId;
              const isPreferred = preferredVersions.get(g.key) === vKey;
              return (
                <div
                  key={vKey}
                  ref={(el) => {
                    if (el) versionCardRefs.current[vKey] = el;
                    else delete versionCardRefs.current[vKey];
                  }}
                  className={`cr-tree-card cr-tree-version-card is-clickable is-${v.item.kind}${
                    isPreferred ? ' is-preferred' : ''
                  }`}
                  data-file-key={g.key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isPreferred}
                  onClick={() => handleSelectPreferred(g.key, vKey)}
                  onMouseEnter={() => setHoveredVersionKey(vKey)}
                  onMouseLeave={() => setHoveredVersionKey((curr) => (curr === vKey ? null : curr))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelectPreferred(g.key, vKey);
                    }
                  }}
                >
                  {/* Top row — who pushed + what kind of change.
                      Purely presentational; the whole card wraps
                      this row and owns the click-to-toggle gesture
                      (see the parent .cr-tree-version-card below). */}
                  <div className="cr-tree-version-author">
                    <AuthorAvatar
                      profile={author}
                      authorId={v.authorId}
                      size={32}
                      ariaLabel={authorName}
                    />
                    <div className="cr-tree-version-author-text">
                      <div className="cr-tree-version-author-name">
                        {authorName}{isAuthorViewer ? ' (you)' : ''}
                      </div>
                      <div className={`cr-tree-version-kind is-${v.item.kind}`}>
                        {kindText}
                      </div>
                    </div>
                  </div>

                  {/* Top-right selection dot — the ONE control for
                      picking this version as the admin's preferred
                      one. Clicking toggles; the card's green outline
                      (`.is-preferred`) mirrors the dot's filled
                      state so the picked status reads at both
                      scales (card-level + corner-level). */}
                  <Tooltip content={isPreferred ? 'Unpick this version' : 'Pick this version'}>
                    <button
                      type="button"
                      className={`cr-tree-version-dot${isPreferred ? ' is-on' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectPreferred(g.key, vKey);
                      }}
                      aria-pressed={isPreferred}
                      aria-label={isPreferred ? 'Unpick this version' : 'Pick this version'}
                    />
                  </Tooltip>

                  {/* Middle — the file the change targets, with the
                      NEW (proposed) thumbnail. preferPending flips
                      CrThumb's priority so the user sees what the
                      file WILL look like after approval. No click
                      handler here anymore: the dot above owns the
                      selection toggle and the View button below
                      opens the preview, so this row is purely
                      presentational. */}
                  <div className="cr-tree-version-file">
                    <CrThumb
                      cloud={cloud}
                      item={v.item}
                      size={48}
                      preferPending
                      hovered={hoveredVersionKey === vKey}
                    />
                    <div className="cr-tree-version-file-text">
                      <div
                        className="cr-tree-version-file-name"
                        title={fileDisplay}
                      >
                        {fileDisplay}
                      </div>
                      {fileSize && (
                        <div className="cr-tree-version-file-meta">{fileSize}</div>
                      )}
                    </div>
                  </div>

                  {/* Bottom-left — View + Decline. Approve is
                      intentionally absent; merging into main
                      happens from inside the file detail panel
                      after the reviewer has inspected the content.
                      Decline is a quick "no" that doesn't require
                      that inspection step. Admin-only. */}
                  <div className="cr-tree-version-actions">
                    <Tooltip content="Show this version">
                      <button
                        type="button"
                        className="cr-tree-action cr-tree-action-view"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenVersion(v);
                        }}
                        aria-label="View"
                      >
                        View
                      </button>
                    </Tooltip>
                    {isAdmin && (
                      <Tooltip content="Throw away this version">
                        <button
                          type="button"
                          className="cr-tree-action cr-tree-action-decline"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeclineVersion(v);
                          }}
                          disabled={isDeclining}
                        >
                          {isDeclining ? '…' : 'Decline'}
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            }))}
          </div>
        </div>
      </div>

      {/* "Push new commit" FAB — fixed at the viewport's bottom-
          right corner. Jumps to the Files page on the Yours tab
          (the surface that owns the actual local-edit pipeline).
          One CTA replaces the per-version Approve / Decline
          buttons; review now happens inside the file detail panel
          on click. */}
      <Tooltip content="Open your files to push a new commit">
        <button
          type="button"
          className="cr-push-btn-fixed"
          onClick={handlePushNewCommit}
        >
          Push new commit
        </button>
      </Tooltip>

    </div>

      {/* Inspector — same FileDetailModal the Files page uses, in
          read-only mode. Triggered either by clicking a version
          card (shows the proposed version overlaid on the cloud
          row) OR by clicking a file card (shows the cloud row's
          current properties). focusedVersion wins when both are
          set so the user's last interaction stays foregrounded.
          Rendered OUTSIDE .cr-tree-viewport — that container uses
          `contain: layout paint` which would otherwise create a
          containing block for the modal's `position: fixed` backdrop
          and clip the panel to the viewport rectangle (starting
          below the dashboard tabs) instead of letting it fill the
          actual screen height. */}
      {focusedVersion ? (
        <FileDetailModal
          file={buildVersionFile(focusedVersion, cloudFilesById)}
          readOnly
          previewUrlOverride={versionPreviewUrl}
          onClose={() => setFocusedVersion(null)}
        />
      ) : focusedFileId ? (
        <FileDetailModal
          file={cloudFilesById.get(focusedFileId) || null}
          readOnly
          onClose={() => setFocusedFileId(null)}
        />
      ) : null}
    </>
  );
}
