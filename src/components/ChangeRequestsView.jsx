import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  createSignedDownloadUrl,
} from '../lib/projectFiles';
import FileThumbnail from './FileThumbnail';
import Tooltip from './Tooltip';
import ConfirmModal from './ConfirmModal';
import { useMorphPill } from './useMorphPill';
import { describeChangeRequestItem } from '../lib/thumbnailDescriptor';
import { openFileWindow, openDocx, isDocxFile, canOpenInApp } from '../lib/platform';
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

// Filled folder glyph for the folders tier of the tree.
const CrFolderGlyph = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

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
function CrThumb({ cloud, item, size = 56, preferPending = false }) {
  // Hover is tracked locally (for the video-frame slideshow) rather than
  // lifted to the parent — with 100+ cards in the tree, a parent hover
  // state re-rendered EVERY card on each mouse-enter. Self-contained
  // hover keeps the re-render scoped to just this thumbnail.
  const [hovered, setHovered] = useState(false);
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
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

// Reject action on a version card. On hover it's a plain tooltip pill;
// on click that pill morphs (FLIP) into a small panel with a reason
// textarea so the admin can tell the author WHY it was rejected. Wrapped
// as its own component because useMorphPill is a hook and the version
// cards are produced inside a .map() (hooks can't run in a loop). The
// reason is optional — submitting empty just rejects with no note.
function RejectButton({ version, onReject }) {
  const morph = useMorphPill({
    hoverContent: 'Reject this version',
    prompt: {
      title: 'Reject this change',
      message: 'Let the author know why so they can address it.',
      placeholder: 'Reason for rejecting…',
      confirmLabel: 'Reject',
      cancelLabel: 'Cancel',
      danger: true,
      onSubmit: (reason) => onReject(version, reason),
    },
  });
  return (
    <>
      <button
        type="button"
        className="cr-tree-action cr-tree-action-decline"
        onClick={morph.handleOpenPrompt}
        onMouseMove={morph.handleMouseMove}
        onMouseLeave={morph.handleMouseLeave}
      >
        Reject
      </button>
      {morph.node}
    </>
  );
}


export default function ChangeRequestsView() {
  const { selectedProject } = useSelectedProject();
  const projectId = selectedProject?.id || null;
  const {
    requests,
    isAdmin,
    approveRequest,
    rejectRequestItem,
    preferredVersions,
    togglePreferredVersion,
  } = useBranch();
  const { session } = useAuth();
  const viewerId = session?.user?.id || null;

  // Hover-to-preview (video frame slideshow) is tracked inside CrThumb
  // now, not lifted here — a parent hover state re-rendered every card
  // in the tree on each mouse move, which janked hard past a few dozen
  // edits.

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

  // Click a file-column card → open the canonical (main-branch)
  // bytes directly in DocVex's in-app viewer (Word for DOCX,
  // Chromium for image/PDF/video). Read-only by design — Word /
  // Office Online fetch the signed URL as a source. 1800 s TTL so
  // Word and Office Online's external fetches don't race the URL's
  // expiry (see ProjectFiles for the longer rationale).
  const handleOpenFileGroup = useCallback(async (group) => {
    const cloud = group?.fileId ? cloudFilesById.get(group.fileId) : null;
    if (!cloud?.storage_path) return;
    if (!canOpenInApp(cloud.mime_type, cloud.name)) return;
    const { data, error } = await createSignedDownloadUrl(cloud.storage_path, 1800);
    if (error || !data?.signedUrl) return;
    if (isDocxFile(cloud.mime_type, cloud.name)) {
      openDocx({ cloudUrl: data.signedUrl, fileName: cloud.name || 'file' });
      return;
    }
    openFileWindow(data.signedUrl, cloud.name || 'file');
  }, [cloudFilesById]);
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

  // Split groups by whether the file already lives on main. Brand-new
  // files (kind 'add', no target_file_id) have no main-branch version
  // to diff against, so the file→version tree metaphor doesn't fit:
  // they render as their own cards in the "Files with edits" column
  // (flagged with a "New file" pill) rather than as a version chip in
  // "Edits waiting" wired back to a parent file. Everything that does
  // target an existing file (edit/replace/delete) keeps the two-tier
  // tree layout.
  const addGroups = useMemo(
    () => fileGroups.filter(
      (g) => !g.fileId && g.versions.every((v) => v.item?.kind === 'add'),
    ),
    [fileGroups],
  );
  const editGroups = useMemo(
    () => fileGroups.filter(
      (g) => g.fileId || g.versions.some((v) => v.item?.kind !== 'add'),
    ),
    [fileGroups],
  );

  // Group everything by FOLDER for the leftmost tier of the tree. An
  // edit group's folder is where its file currently lives on main
  // (cloud.folder_path); a new file's folder is its proposed folder.
  // So the tree reads Folder → File → Edit, and a file whose folder
  // changed shows under its current folder with a "moved to X" edit.
  // Root ('' folder) sorts first, then alphabetical.
  const folderGroups = useMemo(() => {
    const map = new Map();
    const ensure = (folder) => {
      if (!map.has(folder)) map.set(folder, { folder, edits: [], adds: [] });
      return map.get(folder);
    };
    for (const g of editGroups) {
      const cloud = g.fileId ? cloudFilesById.get(g.fileId) : null;
      ensure(cloud?.folder_path || '').edits.push(g);
    }
    for (const g of addGroups) {
      for (const v of g.versions) {
        ensure(v.item.proposed?.folder_path || '').adds.push({ g, v });
      }
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      if (a.folder === b.folder) return 0;
      if (a.folder === '') return -1;
      if (b.folder === '') return 1;
      return a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' });
    });
    return arr;
  }, [editGroups, addGroups, cloudFilesById]);

  // Layout: single tree view (Files → Versions). The previous
  // groupBy toggle (file / author) and the author-grouped list are
  // gone — the horizontal pannable tree replaced both perspectives
  // with one visual, mirroring the dashboard's Members tree.

  // Clicking the View button on a version card opens the proposed
  // bytes directly in the in-app viewer (Word for DOCX, Chromium for
  // image/PDF/video). Lives below `cloudFilesById` is unnecessary
  // here — handleOpenVersion only reads `item.proposed.pending_storage_path`
  // off the version, no cross-state lookup. 600 s TTL matches the
  // previous flow's inspector-side sign call.
  const handleOpenVersion = useCallback(async (version) => {
    const proposed = version?.item?.proposed || {};
    const pendingPath = proposed.pending_storage_path;
    if (!pendingPath) return;
    const fileName = proposed.name || 'file';
    if (!canOpenInApp(proposed.mime_type, fileName)) return;
    const { data, error } = await createPendingSignedUrl(pendingPath, 1800);
    if (error || !data?.signedUrl) return;
    if (isDocxFile(proposed.mime_type, fileName)) {
      openDocx({ cloudUrl: data.signedUrl, fileName });
      return;
    }
    openFileWindow(data.signedUrl, fileName);
  }, []);

  // Preferred-version selection state + toggle live in BranchContext
  // (lifted out of this view so picks survive tab switches and any
  // future surfaces that need to read the set get one source of
  // truth). Local alias keeps the call sites short.
  const handleSelectPreferred = togglePreferredVersion;

  // Reject a single version, with an optional reason the author sees
  // (stored as the item's decision_note via reject_change_request_item).
  // Returns the promise so the reject pill's panel can keep its spinner
  // up until the round-trip lands. Per-button busy state lives inside
  // the morph pill now, so there's no shared declining-id to track.
  const handleRejectVersion = useCallback(async (version, reason) => {
    if (!version?.item || !isAdmin) return;
    const note = reason && reason.trim() ? reason.trim() : null;
    const { error } = await rejectRequestItem(version.item, note);
    if (!error) bumpRefresh();
  }, [rejectRequestItem, isAdmin, bumpRefresh]);

  // ── Bulk approve ─────────────────────────────────────────────────────
  //
  // Collect the request ids whose preferred version is picked (via the
  // dot on each version card). Approving uploads those proposed bytes
  // into the canonical `projects` bucket via the approve_change_request
  // RPC. Unpicked requests are NOT auto-rejected anymore — rejecting
  // happens per file via the Reject button on each version chip, so
  // the bulk action is now strictly additive.
  //
  // Caveat that still applies: change_requests are approved as a unit.
  // If a single (legacy bundled) request contains edits to three files
  // and the admin picked only ONE version from that request, approving
  // still pulls in the other two. Confirm modal surfaces the count.
  const approveRequestIds = useMemo(() => {
    const pickedRequestIds = new Set();
    for (const [, vKey] of preferredVersions) {
      // vKey shape is `${requestId}:${itemId}` — see how it's keyed
      // where the dot toggles below.
      const colon = vKey.indexOf(':');
      const requestId = colon > 0 ? vKey.slice(0, colon) : null;
      if (requestId) pickedRequestIds.add(requestId);
    }
    return Array.from(pickedRequestIds);
  }, [preferredVersions]);

  // Confirmation modal for the bulk action — admin reviews the count
  // before triggering possibly-irreversible approvals.
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);

  const handleConfirmBulk = useCallback(async () => {
    if (!isAdmin || bulkRunning) return;
    setBulkRunning(true);
    try {
      await Promise.allSettled(approveRequestIds.map((id) => approveRequest(id)));
      bumpRefresh();
    } finally {
      setBulkRunning(false);
      setConfirmingBulk(false);
    }
  }, [isAdmin, bulkRunning, approveRequestIds, approveRequest, bumpRefresh]);

  // ── Tree canvas state ────────────────────────────────────────────────
  // Fixed viewport fills the area below the tabs and scrolls NATIVELY
  // (overflow: auto) — wheel scrolls vertically, the scrollbar/drag pan
  // moves around. Earlier this used a transform: translate(pan) driven
  // by React state, which re-rendered all ~150 cards on every pan
  // mousemove — unusable past a few dozen edits. Native scroll is GPU-
  // composited and never re-renders, so it stays smooth at any count.
  // Drag-pan now mutates scrollLeft/scrollTop directly (no state).
  // Geometry recompute fires on layout changes via ResizeObserver
  // (rAF-throttled) so newly arrived versions auto-link; it does NOT
  // run on scroll (edges live inside the scrolled container, so they
  // move with it for free).
  const viewportRef = useRef(null);
  const containerRef = useRef(null);
  const folderRefs = useRef({});        // folder path → DOM node (folder tier)
  const fileCardRefs = useRef({});      // key → DOM node (edit file cards)
  const addCardRefs = useRef({});       // `${requestId}:${itemId}` → DOM node (new-file cards)
  const versionCardRefs = useRef({});   // `${requestId}:${itemId}` → DOM node
  const [edges, setEdges] = useState([]);
  const dragRef = useRef(null);
  const [viewportTop, setViewportTop] = useState(0);


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

  // Horizontal centring is handled in CSS (`justify-content: safe
  // center` on the scroll viewport), so there's no JS centring pass
  // anymore — one fewer layout write on mount.

  // Mouse-drag panning — drag the empty canvas to scroll. Mutates the
  // viewport's scrollLeft/scrollTop directly so dragging never triggers
  // a React re-render (the old setPan approach re-rendered every card
  // per mousemove). Listeners live on window so a drag keeps tracking
  // even when the cursor leaves the viewport.
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const vp = viewportRef.current;
      if (!vp) return;
      vp.scrollLeft = d.baseLeft - (e.clientX - d.startX);
      vp.scrollTop = d.baseTop - (e.clientY - d.startY);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      viewportRef.current?.classList.remove('is-dragging');
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
    const vp = viewportRef.current;
    if (!vp) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseLeft: vp.scrollLeft, baseTop: vp.scrollTop,
    };
    vp.classList.add('is-dragging');
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
      const measure = (node) => {
        const r = node.getBoundingClientRect();
        return {
          rx: r.right - cRect.left,
          lx: r.left - cRect.left,
          my: (r.top + r.bottom) / 2 - cRect.top,
        };
      };
      // Shared-spine connector: ONE trunk from the parent's right edge to
      // a vertical spine sitting just left of the children, then a short
      // horizontal branch from the spine to each child. So a parent with
      // N children draws 1 trunk + 1 spine + N branches (a tree "bus"),
      // not N independent elbows. Aligned single children collapse to a
      // straight horizontal line. One <path> per parent (multiple M
      // subpaths in a single `d`).
      const STUB = 22;     // gap between the spine and the children's edge
      const connect = (parentNode, childNodes) => {
        if (!parentNode) return;
        const kids = childNodes.filter(Boolean).map(measure);
        if (kids.length === 0) return;
        const p = measure(parentNode);
        const childLeft = Math.min(...kids.map((k) => k.lx));
        // Spine sits a stub's width left of the children, but never left
        // of (or on top of) the parent.
        const spineX = Math.max(p.rx + 8, childLeft - STUB);
        let d = `M ${p.rx} ${p.my} H ${spineX}`;            // trunk
        const ys = [p.my, ...kids.map((k) => k.my)];
        const yTop = Math.min(...ys);
        const yBottom = Math.max(...ys);
        if (yTop !== yBottom) d += ` M ${spineX} ${yTop} V ${yBottom}`; // spine
        for (const k of kids) {
          d += ` M ${spineX} ${k.my} H ${k.lx}`;            // branch to child
        }
        next.push(d);
      };

      // Folder → its files.
      for (const fg of folderGroups) {
        connect(folderRefs.current[fg.folder], [
          ...fg.edits.map((g) => fileCardRefs.current[g.key]),
          ...fg.adds.map(({ v }) => addCardRefs.current[`${v.requestId}:${v.item.id}`]),
        ]);
      }
      // File → its versions.
      for (const g of editGroups) {
        connect(
          fileCardRefs.current[g.key],
          g.versions.map((v) => versionCardRefs.current[`${v.requestId}:${v.item.id}`]),
        );
      }
      setEdges(next);
    };

    // rAF-coalesce: a single layout pass fires the ResizeObserver once
    // per observed node (150+ nodes → 150+ callbacks); without this the
    // O(n) recompute ran for each, janking the mount. Batch them into
    // one recompute per frame.
    let rafId = 0;
    const scheduleRecompute = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; recompute(); });
    };

    recompute();
    const observer = new ResizeObserver(scheduleRecompute);
    observer.observe(container);
    for (const node of Object.values(folderRefs.current)) {
      if (node) observer.observe(node);
    }
    for (const node of Object.values(fileCardRefs.current)) {
      if (node) observer.observe(node);
    }
    for (const node of Object.values(addCardRefs.current)) {
      if (node) observer.observe(node);
    }
    for (const node of Object.values(versionCardRefs.current)) {
      if (node) observer.observe(node);
    }
    return () => { if (rafId) cancelAnimationFrame(rafId); observer.disconnect(); };
  }, [editGroups, folderGroups]);

  // ── Card renderers ───────────────────────────────────────────────────────
  // Extracted so the nested Folder → Files → Versions layout can compose
  // them with each parent pinned to the TOP of its children list (folder
  // ↔ its first file, file ↔ its first edit) via `align-items: flex-start`
  // on the row wrappers.
  const renderEditFileCard = (g) => {
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
        ref={(el) => {
          if (el) fileCardRefs.current[g.key] = el;
          else delete fileCardRefs.current[g.key];
        }}
        className={`cr-tree-card cr-tree-file-card${hasCloud ? ' is-clickable' : ''}`}
        data-file-key={g.key}
        onClick={hasCloud ? () => handleOpenFileGroup(g) : undefined}
        role={hasCloud ? 'button' : undefined}
        tabIndex={hasCloud ? 0 : undefined}
        onKeyDown={hasCloud ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleOpenFileGroup(g);
          }
        } : undefined}
      >
        <CrThumb cloud={cloud} item={g.versions[0]?.item} size={44} preferPending={false} />
        <div className="cr-tree-card-text">
          <div className="cr-tree-card-name" title={name}>{name}</div>
          <div className="cr-tree-card-meta">{meta}</div>
        </div>
      </div>
    );
    return hasCloud
      ? <Tooltip content="Open this file">{card}</Tooltip>
      : card;
  };

  const renderAddCard = (g, v) => {
    const author = authorsById[v.authorId];
    const authorName = authorDisplayName(author);
    const isAuthorViewer = v.authorId === viewerId;
    const proposedName = v.item.proposed?.name;
    const fileDisplay = proposedName
      || ((v.item.proposed?.storage_path || '').split('/').pop())
      || '(file)';
    const fileSizeBytes = v.item.proposed?.size_bytes ?? null;
    const fileSize = fileSizeBytes != null ? formatBytes(fileSizeBytes) : null;
    const addFolder = v.item.proposed?.folder_path || '';
    const vKey = `${v.requestId}:${v.item.id}`;
    const isPreferred = preferredVersions.get(g.key) === vKey;
    return (
      <div
        key={vKey}
        ref={(el) => {
          if (el) addCardRefs.current[vKey] = el;
          else delete addCardRefs.current[vKey];
        }}
        className={`cr-tree-card cr-tree-version-card cr-tree-add-card is-clickable is-add${
          isPreferred ? ' is-preferred' : ''
        }`}
        data-file-key={g.key}
        role="button"
        tabIndex={0}
        aria-pressed={isPreferred}
        onClick={() => handleSelectPreferred(g.key, vKey)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSelectPreferred(g.key, vKey);
          }
        }}
      >
        <span className="cr-tree-new-pill">New file</span>
        <div className="cr-tree-version-author">
          <AuthorAvatar profile={author} authorId={v.authorId} size={32} ariaLabel={authorName} />
          <div className="cr-tree-version-author-text">
            <div className="cr-tree-version-author-name">
              {authorName}{isAuthorViewer ? ' (you)' : ''}
            </div>
          </div>
        </div>
        <Tooltip content={isPreferred ? 'Unpick this version' : 'Pick this version'}>
          <button
            type="button"
            className={`cr-tree-version-dot${isPreferred ? ' is-on' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleSelectPreferred(g.key, vKey); }}
            aria-pressed={isPreferred}
            aria-label={isPreferred ? 'Unpick this version' : 'Pick this version'}
          />
        </Tooltip>
        <div className="cr-tree-version-file">
          <CrThumb cloud={null} item={v.item} size={48} preferPending />
          <div className="cr-tree-version-file-text">
            <div className="cr-tree-version-file-name" title={fileDisplay}>{fileDisplay}</div>
            <div className="cr-tree-version-file-meta">
              {addFolder ? `in “${addFolder}”` : 'in the main folder'}
              {fileSize ? ` · ${fileSize}` : ''}
            </div>
          </div>
        </div>
        <div className="cr-tree-version-actions">
          <Tooltip content="Show this file">
            <button
              type="button"
              className="cr-tree-action cr-tree-action-view"
              onClick={(e) => { e.stopPropagation(); handleOpenVersion(v); }}
              aria-label="View"
            >
              View
            </button>
          </Tooltip>
          {isAdmin && <RejectButton version={v} onReject={handleRejectVersion} />}
        </div>
      </div>
    );
  };

  const renderVersionCard = (g, v) => {
    const author = authorsById[v.authorId];
    const authorName = authorDisplayName(author);
    const isAuthorViewer = v.authorId === viewerId;
    const cloud = v.item.target_file_id ? cloudFilesById.get(v.item.target_file_id) : null;
    const proposedName = v.item.proposed?.name;
    const showRename = v.item.kind === 'edit' && proposedName
      && cloud?.name && cloud.name !== proposedName;
    const proposedFolder = (v.item.proposed && 'folder_path' in v.item.proposed)
      ? (v.item.proposed.folder_path || '')
      : null;
    const folderMoved = v.item.kind === 'edit'
      && proposedFolder !== null
      && proposedFolder !== (cloud?.folder_path || '');
    const folderLabel = proposedFolder ? `“${proposedFolder}”` : 'the main folder';
    let kindText;
    if (showRename && folderMoved) kindText = `Rename to "${proposedName}" · moved to ${folderLabel}`;
    else if (folderMoved) kindText = `Moved to ${folderLabel}`;
    else if (showRename) kindText = `Rename to "${proposedName}"`;
    else kindText = (KIND_LABEL[v.item.kind] || v.item.kind);
    const fileDisplay = proposedName
      || cloud?.name
      || ((v.item.proposed?.storage_path || '').split('/').pop())
      || '(file)';
    const fileSizeBytes = v.item.proposed?.size_bytes ?? cloud?.size_bytes ?? null;
    const fileSize = fileSizeBytes != null ? formatBytes(fileSizeBytes) : null;
    const vKey = `${v.requestId}:${v.item.id}`;
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
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSelectPreferred(g.key, vKey);
          }
        }}
      >
        <div className="cr-tree-version-author">
          <AuthorAvatar profile={author} authorId={v.authorId} size={32} ariaLabel={authorName} />
          <div className="cr-tree-version-author-text">
            <div className="cr-tree-version-author-name">
              {authorName}{isAuthorViewer ? ' (you)' : ''}
            </div>
            <div className={`cr-tree-version-kind is-${v.item.kind}`}>{kindText}</div>
          </div>
        </div>
        <Tooltip content={isPreferred ? 'Unpick this version' : 'Pick this version'}>
          <button
            type="button"
            className={`cr-tree-version-dot${isPreferred ? ' is-on' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleSelectPreferred(g.key, vKey); }}
            aria-pressed={isPreferred}
            aria-label={isPreferred ? 'Unpick this version' : 'Pick this version'}
          />
        </Tooltip>
        <div className="cr-tree-version-file">
          <CrThumb cloud={cloud} item={v.item} size={48} preferPending />
          <div className="cr-tree-version-file-text">
            <div className="cr-tree-version-file-name" title={fileDisplay}>{fileDisplay}</div>
            {fileSize && <div className="cr-tree-version-file-meta">{fileSize}</div>}
          </div>
        </div>
        <div className="cr-tree-version-actions">
          <Tooltip content="Show this version">
            <button
              type="button"
              className="cr-tree-action cr-tree-action-view"
              onClick={(e) => { e.stopPropagation(); handleOpenVersion(v); }}
              aria-label="View"
            >
              View
            </button>
          </Tooltip>
          {isAdmin && <RejectButton version={v} onReject={handleRejectVersion} />}
        </div>
      </div>
    );
  };

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
      className="cr-tree-viewport"
      onMouseDown={handlePanMouseDown}
      style={{ top: `${viewportTop}px` }}
    >
      <div
        className="cr-tree"
        ref={containerRef}
      >
        <svg className="cr-tree-edges" aria-hidden="true">
          {edges.map((d, i) => (
            <path key={i} d={d} fill="none" />
          ))}
        </svg>

        {/* Nested tree: Folder → its files → each file’s edits.
            Row wrappers use align-items:flex-start so a source card
            sits at the same height as the first item in its list. */}
        <div className="cr-tree-forest">
          {folderGroups.map((fg) => {
            const count = fg.edits.length + fg.adds.length;
            return (
              <div className="cr-tree-folder-row" key={fg.folder || '__root__'}>
                <div
                  ref={(el) => {
                    if (el) folderRefs.current[fg.folder] = el;
                    else delete folderRefs.current[fg.folder];
                  }}
                  className="cr-tree-card cr-tree-folder-card"
                >
                  <span className="cr-tree-folder-icon">{CrFolderGlyph}</span>
                  <div className="cr-tree-card-text">
                    <div className="cr-tree-card-name" title={fg.folder || 'Main folder'}>
                      {fg.folder || 'Main folder'}
                    </div>
                    <div className="cr-tree-card-meta">
                      {count} {count === 1 ? 'file' : 'files'}
                    </div>
                  </div>
                </div>
                <div className="cr-tree-files-block">
                  {fg.edits.map((g) => (
                    <div className="cr-tree-file-row" key={g.key}>
                      {renderEditFileCard(g)}
                      {g.versions.length > 0 && (
                        <div className="cr-tree-versions-block">
                          {g.versions.map((v) => renderVersionCard(g, v))}
                        </div>
                      )}
                    </div>
                  ))}
                  {fg.adds.map(({ g, v }) => renderAddCard(g, v))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Action bar — admin-only bulk approve FAB pinned to the
          bottom-right. Approves every request whose preferred version
          is picked; rejecting is per-file via the Reject button on
          each version chip. Hidden when no picks are staged. */}
      {isAdmin && approveRequestIds.length > 0 && (
        <div className="cr-action-bar">
          <Tooltip content="Approve picked versions">
            <button
              type="button"
              className="cr-action-fab cr-action-fab-primary"
              onClick={() => setConfirmingBulk(true)}
              disabled={bulkRunning}
            >
              {bulkRunning ? 'Working…' : 'Approve'}
            </button>
          </Tooltip>
        </div>
      )}

    </div>

      {/* Confirm before firing the bulk approve — irreversible at the
          RPC layer (approved requests become rows in project_files).
          Count comes from the same memo the action button uses so
          the modal can't drift from what'll actually run. */}
      <ConfirmModal
        open={confirmingBulk}
        title="Approve picked versions"
        message={(
          <span>
            Approve <strong>{approveRequestIds.length}</strong>{' '}
            request{approveRequestIds.length === 1 ? '' : 's'} — bytes
            will be uploaded to the cloud.
          </span>
        )}
        confirmLabel={bulkRunning ? 'Working…' : 'Approve'}
        cancelLabel="Cancel"
        onConfirm={handleConfirmBulk}
        onCancel={() => setConfirmingBulk(false)}
      />
    </>
  );
}
