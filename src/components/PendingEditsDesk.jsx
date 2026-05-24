import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useBranch } from '../context/BranchContext';
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
import { describeChangeRequestItem } from '../lib/thumbnailDescriptor';
import { openFileWindow, openDocx, isDocxFile, canOpenInApp } from '../lib/platform';
import FileThumbnail from './FileThumbnail';
import ConfirmModal from './ConfirmModal';
import { useMorphPill } from './useMorphPill';
import './PendingEditsDesk.css';

// ════════════════════════════════════════════════════════════════════════
// PendingEditsDesk — "Document Desk" compose-release surface for the Project
// Dashboard's "Pending edits" tab. Ported from the Claude Design handoff
// (Direction B) and wired to the REAL change-request data:
//
//   • Each FILE with pending edits is a chip in the kanban row.
//   • Selecting a file shows every teammate's DRAFT of it side-by-side, in a
//     per-kind pane (new / edit / rename / move / delete / replace), or a
//     "mixed conflict" when teammates disagree on the action.
//   • The admin PICKS one draft per file; Publish runs approveRelease() on
//     the picked requests (one main_version bump for the whole release).
//
// Data plumbing mirrors ChangeRequestsView (same fetch + BranchContext picks)
// so picks survive tab switches and the approve flow is identical.
// ════════════════════════════════════════════════════════════════════════

const KIND_META = {
  edit:     { label: 'edit',     verb: 'Use this version',    tone: 'edit',    glyph: 'pencil' },
  new:      { label: 'new file', verb: 'Add this file',       tone: 'new',     glyph: 'plus' },
  rename:   { label: 'renamed',  verb: 'Apply rename',        tone: 'rename',  glyph: 'rename' },
  move:     { label: 'moved',    verb: 'Move file',           tone: 'move',    glyph: 'move' },
  delete:   { label: 'remove',   verb: 'Remove from project', tone: 'delete',  glyph: 'trash' },
  replace:  { label: 'replace',  verb: 'Use the new file',    tone: 'replace', glyph: 'swap' },
  mixed:    { label: 'conflict', verb: 'Pick a side',         tone: 'mixed',   glyph: 'warn' },
  conflict: { label: 'conflict', verb: 'Pick a version',      tone: 'conflict',glyph: 'warn' },
};

// ── Inline glyphs (CLAUDE.md convention) ──────────────────────────────
function Icon({ name, size = 14 }) {
  const p = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  switch (name) {
    case 'check':  return <svg {...p}><polyline points="20 6 9 17 4 12" /></svg>;
    case 'folder': return <svg {...p} fill="currentColor" stroke="none"><path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2a2 2 0 0 0 1.6.8H19a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
    case 'doc':    return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>;
    case 'send':   return <svg {...p}><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>;
    case 'plus':   return <svg {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case 'pencil': return <svg {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>;
    case 'rename': return <svg {...p}><path d="M3 12h12" /><polyline points="11 6 17 12 11 18" /><path d="M21 6v12" /></svg>;
    case 'move':   return <svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 13h6" /><polyline points="13 11 15 13 13 15" /></svg>;
    case 'trash':  return <svg {...p}><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></svg>;
    case 'swap':   return <svg {...p}><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>;
    case 'warn':   return <svg {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
    case 'stamp':  return <svg {...p}><path d="M8 2h8l-1 7a3 3 0 0 1-3 3 3 3 0 0 1-3-3z" /><line x1="4" y1="17" x2="20" y2="17" /><rect x="4" y="19" width="16" height="3" rx="0.5" /></svg>;
    default: return null;
  }
}

// ── Author color (mirrors ChangeRequestsView) ─────────────────────────
const AUTHOR_COLORS = ['#22c55e', '#ef4444', '#a855f7', '#facc15', '#3b82f6', '#ec4899', '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4', '#84cc16', '#f43f5e'];
function authorColor(id) {
  if (!id) return AUTHOR_COLORS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h |= 0; }
  return AUTHOR_COLORS[Math.abs(h) % AUTHOR_COLORS.length];
}
function authorDisplayName(profile) {
  if (!profile) return 'Teammate';
  return profile.full_name || profile.name || profile.email || 'Teammate';
}
function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toUpperCase() : 'FILE';
}

// File identity grouping (same keys as ChangeRequestsView so picks line up
// with BranchContext's preferredVersions + approveRelease).
function fileKeyFor(item) {
  if (item.target_file_id) return `f:${item.target_file_id}`;
  if (item.kind === 'add' && item.proposed?.name) return `a:${item.proposed.name.toLowerCase()}`;
  return `x:${item.id}`;
}
function fileDisplayName(group, cloudFilesById) {
  if (!group.fileId) return group.versions[0]?.item?.proposed?.name || 'unnamed';
  const cf = cloudFilesById.get(group.fileId);
  if (cf?.name) return cf.name;
  for (const v of group.versions) if (v.item?.proposed?.name) return v.item.proposed.name;
  return `file ${group.fileId.slice(0, 8)}`;
}

// Real kinds are add/edit/delete/replace — rename & move are edits whose
// proposed name/folder differs from the live row WITHOUT a byte change
// (content_hash unchanged). Anything that also changes bytes stays 'edit'.
function draftKind(item, cloud) {
  if (item.kind === 'add') return 'new';
  if (item.kind === 'delete') return 'delete';
  if (item.kind === 'replace') return 'replace';
  const p = item.proposed || {};
  const renamed = p.name && cloud?.name && cloud.name !== p.name;
  const proposedFolder = ('folder_path' in p) ? (p.folder_path || '') : null;
  const moved = proposedFolder !== null && proposedFolder !== (cloud?.folder_path || '');
  const bytesChanged = p.content_hash && cloud?.content_hash && p.content_hash !== cloud.content_hash;
  if (!bytesChanged && renamed && !moved) return 'rename';
  if (!bytesChanged && moved && !renamed) return 'move';
  return 'edit';
}

// ── Avatar ────────────────────────────────────────────────────────────
function Avatar({ profile, authorId, size = 30 }) {
  const url = profile?.avatar_url;
  const initial = (profile?.full_name || profile?.name || profile?.email || '?').charAt(0).toUpperCase();
  return (
    <span className="dv-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: url ? 'var(--bg-elevated)' : authorColor(authorId) }} title={authorDisplayName(profile)}>
      {url ? <img src={url} alt="" referrerPolicy="no-referrer" draggable={false} /> : initial}
    </span>
  );
}

// ── Real-file thumbnail (proposed bytes or live bytes) ────────────────
function Thumb({ cloud, item, preferPending = true }) {
  const [hovered, setHovered] = useState(false);
  const descriptor = useMemo(
    () => describeChangeRequestItem({ item, cloud, preferPending }),
    [item, cloud, preferPending],
  );
  return (
    <span className="pe-thumb" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <FileThumbnail descriptor={descriptor} hovered={hovered} />
    </span>
  );
}

// ── Reject (admin) — hover tooltip morphs into a reason prompt ─────────
function RejectButton({ draft, onReject }) {
  const morph = useMorphPill({
    hoverContent: 'Reject this version',
    prompt: {
      title: 'Reject this change',
      message: 'Let the author know why so they can address it.',
      placeholder: 'Reason for rejecting…',
      confirmLabel: 'Reject',
      cancelLabel: 'Cancel',
      danger: true,
      onSubmit: (reason) => onReject(draft, reason),
    },
  });
  return (
    <>
      <button
        type="button"
        className="dv-btn rb-reject-btn"
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

// ── Pane shell ────────────────────────────────────────────────────────
function PaneHeader({ file, draft, author, picked }) {
  const meta = KIND_META[draft.kind] || KIND_META.edit;
  return (
    <div className="rb-pane-head">
      <Avatar profile={author} authorId={draft.authorId} size={30} />
      <div className="rb-pane-text">
        <div className="rb-pane-author">{authorDisplayName(author)}</div>
        <div className="rb-pane-when">{draft.requestTitle || 'Submitted for review'}</div>
      </div>
      {picked && (
        <span className="dv-pill is-ok rb-pane-pickpill"><Icon name="check" size={10} /> Picked</span>
      )}
      <span className={`rb-kindbadge is-${meta.tone}`}><Icon name={meta.glyph} size={12} /> {meta.label}</span>
    </div>
  );
}

function PaneFooter({ file, draft, picked, onPick, onView, canReject, onReject, fullWidth }) {
  const meta = KIND_META[draft.kind] || KIND_META.edit;
  const isDanger = draft.kind === 'delete';
  return (
    <div className={`rb-pane-foot${fullWidth ? ' rb-pane-foot-center' : ''}`}>
      <button type="button" className="dv-btn" onClick={() => onView(draft)}>View</button>
      <button
        type="button"
        className={`dv-btn rb-pick-btn${picked ? ' is-primary' : ''}${isDanger && !picked ? ' is-danger' : ''}`}
        onClick={() => onPick(file.key, draft.vKey)}
      >
        {picked
          ? <><Icon name="check" size={14} /> Picked for this release</>
          : <><Icon name={meta.glyph} size={14} /> {meta.verb}</>}
      </button>
      {canReject && <RejectButton draft={draft} onReject={onReject} />}
    </div>
  );
}

// ── Per-kind pane bodies ──────────────────────────────────────────────
function PaneBody({ file, draft }) {
  const cloud = draft.cloud;
  const p = draft.item.proposed || {};
  const meta = KIND_META[draft.kind] || KIND_META.edit;

  if (draft.kind === 'new') {
    const size = p.size_bytes != null ? formatBytes(p.size_bytes) : null;
    return (
      <>
        <div className="rb-newfile-banner">
          <div className="rb-newfile-icon"><Icon name="doc" size={20} /></div>
          <div>
            <div className="rb-newfile-name">{p.name || file.name}</div>
            <div className="rb-newfile-meta">
              <span><Icon name="folder" size={11} /> {p.folder_path || 'top level'}</span>
              {size && <><span>·</span><span>{size}</span></>}
              <span>·</span><span>not in project yet</span>
            </div>
          </div>
        </div>
        <div className="rb-preview">
          <Thumb cloud={null} item={draft.item} preferPending />
          <div className="rb-preview-text">
            <div className="rb-preview-name">{p.name || file.name}</div>
            <div className="rb-preview-note">A brand-new file proposed by {authorDisplayName(null)}. Open it to read the full document before adding it.</div>
          </div>
        </div>
      </>
    );
  }

  if (draft.kind === 'rename') {
    return (
      <>
        <div className="rb-namechange">
          <div className="rb-namechange-side is-old">
            <div className="rb-namechange-label">Currently named</div>
            <div className="rb-namechange-value"><Icon name="doc" size={14} /> {cloud?.name || file.name}</div>
          </div>
          <div className="rb-namechange-arrow"><Icon name="rename" size={26} /></div>
          <div className="rb-namechange-side is-new">
            <div className="rb-namechange-label">Will be renamed to</div>
            <div className="rb-namechange-value"><Icon name="doc" size={14} /> {p.name}</div>
          </div>
        </div>
        <div className="rb-noteline"><Icon name="check" size={13} /> The file's content stays exactly the same — only the name changes.</div>
      </>
    );
  }

  if (draft.kind === 'move') {
    const oldParts = (cloud?.folder_path || '').split('/').map((s) => s.trim()).filter(Boolean);
    const newParts = (p.folder_path || '').split('/').map((s) => s.trim()).filter(Boolean);
    const stack = (parts, isNew) => (
      <div className="rb-folder-stack">
        {parts.length === 0 && <div className="rb-folder-row"><Icon name="folder" size={14} /> top level</div>}
        {parts.map((seg, i) => (
          <div key={i} className="rb-folder-row" style={{ paddingLeft: i * 14 }}><Icon name="folder" size={14} /> {seg}</div>
        ))}
        <div className="rb-folder-row is-file" style={{ paddingLeft: parts.length * 14 }}><Icon name="doc" size={14} /> {file.name}</div>
      </div>
    );
    return (
      <>
        <div className="rb-folder-move">
          <div className="rb-folder-card is-old"><div className="rb-folder-label">Now sitting in</div>{stack(oldParts, false)}</div>
          <div className="rb-folder-arrow"><Icon name="move" size={26} /></div>
          <div className="rb-folder-card is-new"><div className="rb-folder-label">Will move to</div>{stack(newParts, true)}</div>
        </div>
        <div className="rb-noteline"><Icon name="check" size={13} /> The file is not edited — only its location in the project changes.</div>
      </>
    );
  }

  if (draft.kind === 'delete') {
    return (
      <>
        <div className="rb-delete-banner">
          <Icon name="warn" size={20} />
          <div>
            <div className="rb-delete-banner-h">Marked for removal</div>
            <div className="rb-delete-banner-sub">If you approve this, <strong>{file.name}</strong> disappears from the project once you publish. Your team and clients will no longer see it.</div>
          </div>
        </div>
        <div className="rb-preview">
          <Thumb cloud={cloud} item={draft.item} preferPending={false} />
          <div className="rb-preview-text">
            <div className="rb-preview-name">{file.name}</div>
            <div className="rb-preview-note">{file.folder ? `In “${file.folder}”` : 'At the top level'}{cloud?.size_bytes != null ? ` · ${formatBytes(cloud.size_bytes)}` : ''}</div>
          </div>
        </div>
      </>
    );
  }

  if (draft.kind === 'replace') {
    const oldFmt = extOf(cloud?.name || file.name);
    const newFmt = extOf(p.name || file.name);
    return (
      <>
        <div className="rb-replace">
          <div className="rb-replace-card is-old">
            <div className="rb-replace-badge">{oldFmt}</div>
            <div className="rb-replace-label">Currently on file</div>
            <div className="rb-replace-name">{cloud?.name || file.name}</div>
            <div className="rb-replace-size">{cloud?.size_bytes != null ? formatBytes(cloud.size_bytes) : ''}</div>
          </div>
          <div className="rb-replace-arrow"><Icon name="swap" size={26} /><span>replaced by</span></div>
          <div className="rb-replace-card is-new">
            <div className="rb-replace-badge is-new">{newFmt}</div>
            <div className="rb-replace-label">New version</div>
            <div className="rb-replace-name">{p.name || file.name}</div>
            <div className="rb-replace-size">{p.size_bytes != null ? formatBytes(p.size_bytes) : ''}</div>
          </div>
        </div>
        <div className="rb-noteline"><Icon name="warn" size={13} /> Replacement makes the old file invisible — only the new version stays in the project.</div>
      </>
    );
  }

  // edit (default)
  return (
    <div className="rb-preview">
      <Thumb cloud={cloud} item={draft.item} preferPending />
      <div className="rb-preview-text">
        <div className="rb-preview-name">{p.name || file.name}</div>
        <div className="rb-preview-note">
          Edited version of the live file{p.size_bytes != null ? ` · ${formatBytes(p.size_bytes)}` : ''}. Open it to compare against what's published.
        </div>
      </div>
    </div>
  );
}

function Pane({ file, draft, authorsById, picked, onPick, onView, canReject, onReject, fullWidth }) {
  return (
    <section className={`rb-pane${fullWidth ? ' is-fullwidth' : ''}${picked ? ' is-picked' : ''}`}>
      <PaneHeader file={file} draft={draft} author={authorsById[draft.authorId]} picked={picked} />
      <PaneBody file={file} draft={draft} />
      <PaneFooter file={file} draft={draft} picked={picked} onPick={onPick} onView={onView} canReject={canReject} onReject={onReject} fullWidth={fullWidth} />
    </section>
  );
}

// ── VS column ─────────────────────────────────────────────────────────
function VsColumn({ left, right }) {
  const mixed = left.kind !== right.kind;
  return (
    <div className="rb-vs">
      <div className="rb-vs-line" />
      <div className="rb-vs-badge">{mixed ? '!' : 'VS'}</div>
      <div className="rb-vs-line" />
      <div className="rb-vs-diff">
        <div className="rb-vs-diffrow"><span className={`rb-vs-dot is-${left.kind}`} />{(KIND_META[left.kind] || {}).label}</div>
        <div className="rb-vs-diffrow"><span className={`rb-vs-dot is-${right.kind}`} />{(KIND_META[right.kind] || {}).label}</div>
      </div>
    </div>
  );
}

// ── File chip (kanban) ────────────────────────────────────────────────
function FileChip({ file, tone, decided, authorsById, active, onClick }) {
  const conflict = file.drafts.length > 1;
  const meta = KIND_META[tone] || KIND_META.edit;
  let label, glyph;
  if (decided) { label = 'decided'; glyph = 'check'; }
  else if (tone === 'mixed') { label = 'mixed conflict'; glyph = 'warn'; }
  else if (conflict) { label = `${file.drafts.length} drafts conflict`; glyph = 'warn'; }
  else { label = meta.label; glyph = meta.glyph; }
  return (
    <button type="button" className={`rb-chip rb-chip-${decided ? 'decided' : tone}${active ? ' is-active' : ''}`} onClick={onClick}>
      <span className="rb-chip-icon"><Icon name={glyph} size={14} /></span>
      <span className="rb-chip-text">
        <span className="rb-chip-name" title={file.name}>{file.name}</span>
        <span className="rb-chip-meta">{label}</span>
      </span>
      <span className="rb-chip-authors">
        {file.drafts.slice(0, 3).map((d) => (
          <Avatar key={d.vKey} profile={authorsById[d.authorId]} authorId={d.authorId} size={18} />
        ))}
      </span>
    </button>
  );
}

// ── Tray pill ─────────────────────────────────────────────────────────
function TrayPill({ file, draft, authorsById }) {
  if (!draft) {
    return <div className="rb-tray-item is-empty" title={`${file.name} — awaiting decision`}><Icon name="doc" size={16} /></div>;
  }
  const meta = KIND_META[draft.kind] || KIND_META.edit;
  return (
    <div className={`rb-tray-item rb-tray-item-${meta.tone}`} title={`${file.name} · ${authorDisplayName(authorsById[draft.authorId])} · ${meta.label}`}>
      <Avatar profile={authorsById[draft.authorId]} authorId={draft.authorId} size={18} />
      <span className="rb-tray-item-name">{file.name.length > 22 ? `${file.name.slice(0, 22)}…` : file.name}</span>
      <span className="rb-tray-item-kind"><Icon name={meta.glyph} size={11} /> {meta.label}</span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
export default function PendingEditsDesk() {
  const { selectedProject } = useSelectedProject();
  const projectId = selectedProject?.id || null;
  const {
    requests,
    isAdmin,
    approveRelease,
    rejectRequestItem,
    preferredVersions,
    togglePreferredVersion,
  } = useBranch();

  const openRequests = useMemo(() => (requests || []).filter((r) => r.status === 'open'), [requests]);

  const [allVersions, setAllVersions] = useState([]); // { requestId, requestTitle, authorId, item }
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [authorsById, setAuthorsById] = useState({});
  const [cloudFilesById, setCloudFilesById] = useState(new Map());
  const [refreshTick, setRefreshTick] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  const [selectedKey, setSelectedKey] = useState(null);
  const [rightDraftIdx, setRightDraftIdx] = useState(1);
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);

  // Fetch open-request items (one batched query, refetch on tick).
  useEffect(() => {
    if (!projectId) { setAllVersions([]); setVersionsLoading(false); return undefined; }
    let cancelled = false;
    setVersionsLoading(true);
    listOpenChangeRequestItemsForProject(projectId).then(({ data, error }) => {
      if (cancelled) return;
      setAllVersions(error ? [] : (data || []));
      setVersionsLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, refreshTick]);

  // Realtime: any item change bumps the tick.
  useEffect(() => {
    if (!projectId) return undefined;
    return subscribeChangeRequestItemsForProject(projectId, () => bumpRefresh());
  }, [projectId, bumpRefresh]);

  // Request status flips → refetch items too.
  const openRequestIdsKey = useMemo(() => openRequests.map((r) => r.id).sort().join('|'), [openRequests]);
  useEffect(() => { bumpRefresh(); }, [openRequestIdsKey, bumpRefresh]);

  // Cloud file list (canonical names + live metadata).
  useEffect(() => {
    if (!projectId) { setCloudFilesById(new Map()); return undefined; }
    let cancelled = false;
    listProjectFiles(projectId).then(({ data }) => {
      if (cancelled) return;
      const m = new Map();
      for (const f of data || []) m.set(f.id, f);
      setCloudFilesById(m);
    });
    return () => { cancelled = true; };
  }, [projectId, refreshTick]);

  // Author profile cache.
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

  // Build files → drafts model.
  const files = useMemo(() => {
    const groups = new Map();
    for (const v of allVersions) {
      const key = fileKeyFor(v.item);
      if (!groups.has(key)) groups.set(key, { key, fileId: v.item.target_file_id || null, versions: [] });
      groups.get(key).versions.push(v);
    }
    const arr = Array.from(groups.values()).map((g) => {
      const cloud = g.fileId ? cloudFilesById.get(g.fileId) : null;
      const name = fileDisplayName(g, cloudFilesById);
      const folder = cloud?.folder_path || g.versions[0]?.item?.proposed?.folder_path || '';
      const drafts = g.versions.map((v) => ({
        vKey: `${v.requestId}:${v.item.id}`,
        requestId: v.requestId,
        requestTitle: v.requestTitle,
        authorId: v.authorId,
        item: v.item,
        cloud,
        kind: draftKind(v.item, cloud),
      }));
      return { key: g.key, fileId: g.fileId, cloud, name, folder, drafts };
    });
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [allVersions, cloudFilesById]);

  // Keep the selected file valid as the list changes.
  useEffect(() => {
    if (files.length === 0) { if (selectedKey !== null) setSelectedKey(null); return; }
    if (!files.some((f) => f.key === selectedKey)) setSelectedKey(files[0].key);
  }, [files, selectedKey]);

  const fileTone = useCallback((f) => {
    if (preferredVersions.has(f.key)) return 'decided';
    if (f.drafts.length > 1) {
      const kinds = new Set(f.drafts.map((d) => d.kind));
      if (kinds.size > 1) return 'mixed';
      return f.drafts[0].kind === 'edit' ? 'conflict' : f.drafts[0].kind;
    }
    return f.drafts[0]?.kind || 'edit';
  }, [preferredVersions]);

  // Picked request ids → the release approveRelease() will merge (one bump).
  const approveRequestIds = useMemo(() => {
    const ids = new Set();
    for (const [, vKey] of preferredVersions) {
      const colon = vKey.indexOf(':');
      if (colon > 0) ids.add(vKey.slice(0, colon));
    }
    return Array.from(ids);
  }, [preferredVersions]);

  // Open a draft's proposed bytes in the in-app viewer.
  const handleView = useCallback(async (draft) => {
    const proposed = draft?.item?.proposed || {};
    const fileName = proposed.name || draft?.cloud?.name || 'file';
    // For pure rename/move/delete there may be no fresh pending bytes — fall
    // back to the live (cloud) file so View still opens something useful.
    const pendingPath = proposed.pending_storage_path;
    if (pendingPath) {
      if (!canOpenInApp(proposed.mime_type, fileName)) return;
      const { data, error } = await createPendingSignedUrl(pendingPath, 1800);
      if (error || !data?.signedUrl) return;
      if (isDocxFile(proposed.mime_type, fileName)) { openDocx({ cloudUrl: data.signedUrl, fileName }); return; }
      openFileWindow(data.signedUrl, fileName);
      return;
    }
    const cloud = draft?.cloud;
    if (cloud?.storage_path && canOpenInApp(cloud.mime_type, cloud.name)) {
      const { data, error } = await createSignedDownloadUrl(cloud.storage_path, 1800);
      if (error || !data?.signedUrl) return;
      if (isDocxFile(cloud.mime_type, cloud.name)) { openDocx({ cloudUrl: data.signedUrl, fileName: cloud.name || fileName }); return; }
      openFileWindow(data.signedUrl, cloud.name || fileName);
    }
  }, []);

  const handleReject = useCallback(async (draft, reason) => {
    if (!draft?.item || !isAdmin) return;
    const note = reason && reason.trim() ? reason.trim() : null;
    const { error } = await rejectRequestItem(draft.item, note);
    if (!error) bumpRefresh();
  }, [rejectRequestItem, isAdmin, bumpRefresh]);

  const handleConfirmBulk = useCallback(async () => {
    if (!isAdmin || bulkRunning) return;
    setBulkRunning(true);
    try {
      await approveRelease(approveRequestIds);
      bumpRefresh();
    } finally {
      setBulkRunning(false);
      setConfirmingBulk(false);
    }
  }, [isAdmin, bulkRunning, approveRelease, approveRequestIds, bumpRefresh]);

  // ── Derived render state ─────────────────────────────────────────────
  const file = files.find((f) => f.key === selectedKey) || files[0] || null;
  const pickedCount = preferredVersions.size;
  const decisionsLeft = files.filter((f) => !preferredVersions.has(f.key) && f.drafts.length > 1).length;

  if (files.length === 0) {
    return (
      <div className="pe-desk">
        <div className="pe-empty">{versionsLoading ? 'Loading…' : 'No edits are waiting for review right now.'}</div>
      </div>
    );
  }

  const drafts = file.drafts;
  const leftDraft = drafts[0];
  const rightDraft = drafts[Math.min(rightDraftIdx, drafts.length - 1)];
  const hasComparison = drafts.length > 1;
  const tone = fileTone(file);
  const pickedVKey = preferredVersions.get(file.key);

  // Desk header instruction.
  const leftAuthorName = authorDisplayName(authorsById[leftDraft.authorId]);
  let eyebrow = (KIND_META[tone] || KIND_META.edit).label.toUpperCase();
  let instruction;
  if (tone === 'mixed') { eyebrow = 'CONFLICTING ACTIONS'; instruction = 'Teammates want different things for this file. Pick which action wins.'; }
  else if (tone === 'conflict') { eyebrow = 'CONFLICTING EDITS'; instruction = `${drafts.length} teammates worked on this — pick the version to publish.`; }
  else if (drafts.length > 1) { eyebrow = 'MULTIPLE DRAFTS'; instruction = 'Two teammates proposed this change. Pick which one to publish.'; }
  else if (leftDraft.kind === 'new') { eyebrow = 'NEW FILE'; instruction = `${leftAuthorName} proposes adding this file to the project.`; }
  else if (leftDraft.kind === 'rename') { eyebrow = 'RENAME'; instruction = `${leftAuthorName} suggests a different filename. The content is untouched.`; }
  else if (leftDraft.kind === 'move') { eyebrow = 'MOVE TO ANOTHER FOLDER'; instruction = `${leftAuthorName} suggests moving the file. The content is untouched.`; }
  else if (leftDraft.kind === 'delete') { eyebrow = 'PROPOSED REMOVAL'; instruction = `${leftAuthorName} asks to remove this file from the project.`; }
  else if (leftDraft.kind === 'replace') { eyebrow = 'REPLACE FILE'; instruction = `${leftAuthorName} provides a new file to take this one's place.`; }
  else { eyebrow = 'SINGLE EDIT'; instruction = `Only ${leftAuthorName} worked on this — approve it as-is or reject it.`; }

  return (
    <div className="pe-desk">
      <header className="rb-top">
        <div>
          <div className="rb-eyebrow">Review desk · {selectedProject?.name || 'this project'}</div>
          <h1 className="rb-title">
            {decisionsLeft > 0
              ? <>You have <span className="rb-title-accent">{decisionsLeft} {decisionsLeft === 1 ? 'decision' : 'decisions'}</span> to make before the next publication.</>
              : <>All decisions made — ready to publish.</>}
          </h1>
          <div className="rb-summary">
            <span className="rb-summary-item"><span className="rb-summary-dot" style={{ background: 'var(--warning)' }} />{decisionsLeft} need a decision</span>
            <span className="rb-summary-item"><span className="rb-summary-dot" style={{ background: 'var(--success)' }} />{pickedCount} picked</span>
            <span className="rb-summary-item"><span className="rb-summary-dot" style={{ background: 'var(--text-muted)' }} />{files.length} total</span>
          </div>
        </div>
      </header>

      {/* Kanban chip row */}
      <div className="rb-files">
        <div className="rb-files-track">
          {files.map((f) => (
            <FileChip
              key={f.key}
              file={f}
              tone={fileTone(f)}
              decided={preferredVersions.has(f.key)}
              authorsById={authorsById}
              active={f.key === file.key}
              onClick={() => { setSelectedKey(f.key); setRightDraftIdx(1); }}
            />
          ))}
        </div>
      </div>

      {/* Desk */}
      <main className="rb-desk">
        <div className="rb-desk-head">
          <div>
            <div className="rb-desk-eyebrow"><Icon name="folder" size={11} /> {file.folder || 'top level'}</div>
            <h2 className="rb-desk-title">{file.name}</h2>
            <div className="rb-desk-meta">
              <span className="rb-desk-tag is-eyebrow">{eyebrow}</span>
              <span>·</span>
              <span>{drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'} on your desk</span>
            </div>
            <div className="rb-desk-instr">{instruction}</div>
          </div>
          {hasComparison && drafts.length > 2 && (
            <div className="rb-tabs">
              <span className="rb-tabs-label">Compare with:</span>
              {drafts.slice(1).map((d, i) => (
                <button key={d.vKey} type="button" className={`rb-tab${rightDraftIdx === i + 1 ? ' is-on' : ''}`} onClick={() => setRightDraftIdx(i + 1)}>
                  <Avatar profile={authorsById[d.authorId]} authorId={d.authorId} size={18} />
                  <span>{authorDisplayName(authorsById[d.authorId]).split(' ')[0]}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {!hasComparison ? (
          <div className="rb-desk-body rb-desk-single">
            <Pane file={file} draft={leftDraft} authorsById={authorsById} picked={pickedVKey === leftDraft.vKey} onPick={togglePreferredVersion} onView={handleView} canReject={isAdmin} onReject={handleReject} fullWidth />
          </div>
        ) : (
          <div className="rb-desk-body">
            <Pane file={file} draft={leftDraft} authorsById={authorsById} picked={pickedVKey === leftDraft.vKey} onPick={togglePreferredVersion} onView={handleView} canReject={isAdmin} onReject={handleReject} />
            <VsColumn left={leftDraft} right={rightDraft} />
            <Pane file={file} draft={rightDraft} authorsById={authorsById} picked={pickedVKey === rightDraft.vKey} onPick={togglePreferredVersion} onView={handleView} canReject={isAdmin} onReject={handleReject} />
          </div>
        )}
      </main>

      {/* Sealed-for-tonight tray */}
      <footer className="rb-tray">
        <div className="rb-tray-label"><Icon name="stamp" size={14} /> Picked for this release</div>
        <div className="rb-tray-items">
          {files.map((f) => {
            const vKey = preferredVersions.get(f.key);
            const draft = vKey ? f.drafts.find((d) => d.vKey === vKey) : null;
            return <TrayPill key={f.key} file={f} draft={draft} authorsById={authorsById} />;
          })}
        </div>
      </footer>

      {/* Fixed publish bar */}
      {isAdmin && (
        <div className="pe-publishbar">
          <div className="pe-publishbar-text">
            {pickedCount > 0
              ? <><strong>{pickedCount}</strong> {pickedCount === 1 ? 'file' : 'files'} picked — publishing composes a new official version.</>
              : 'Pick a version for each file, then publish to compose the next official version.'}
          </div>
          <button type="button" className="dv-btn is-primary rb-publish-btn" disabled={approveRequestIds.length === 0 || bulkRunning} onClick={() => setConfirmingBulk(true)}>
            <Icon name="send" size={14} /> {bulkRunning ? 'Publishing…' : `Publish · ${pickedCount} ${pickedCount === 1 ? 'file' : 'files'}`}
          </button>
        </div>
      )}

      <ConfirmModal
        open={confirmingBulk}
        title="Publish picked versions"
        message={(
          <span>
            Publish <strong>{approveRequestIds.length}</strong>{' '}
            request{approveRequestIds.length === 1 ? '' : 's'} as the next official version — the picked
            files become live for everyone on the project.
          </span>
        )}
        confirmLabel={bulkRunning ? 'Publishing…' : 'Publish'}
        cancelLabel="Cancel"
        onConfirm={handleConfirmBulk}
        onCancel={() => setConfirmingBulk(false)}
      />
    </div>
  );
}
