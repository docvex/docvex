import React, { useCallback, useEffect, useState } from 'react';
import { useBranch } from '../context/BranchContext';
import { useAuth } from '../context/AuthContext';
import {
  getChangeRequest,
  createPendingSignedUrl,
} from '../lib/branches';
import { createSignedDownloadUrl, fetchUploaderProfile } from '../lib/projectFiles';
import Tooltip from './Tooltip';
import './ConfirmModal.css';
import './ChangeRequestsPanel.css';

// Master/detail panel for change requests. List on the left, the
// active request's items + Approve/Reject controls on the right.
//
// Visibility split (driven by RLS + the context):
//   • Members see their own requests across all statuses (their
//     history).
//   • Admins additionally see every member's requests in the project.
//   • The Approve / Reject buttons are admin-only and only render
//     for open requests; authors of an open request see Withdraw.

const CloseIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const STATUS_LABEL = {
  open:      'Open',
  approved:  'Approved',
  rejected:  'Rejected',
  withdrawn: 'Withdrawn',
};

const KIND_LABEL = {
  add:     'Added',
  edit:    'Edited',
  delete:  'Deleted',
  replace: 'Replaced',
};

function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7)   return `${day}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Per-item preview row. Renders the kind badge, the file name + size,
// and (for add/replace) a "Preview" link that signs a pending-bucket
// URL on click and opens it in a new tab.
function ItemRow({ item }) {
  const [previewing, setPreviewing] = useState(false);

  const proposed = item.proposed || {};
  const fileName = proposed.name || `File ${item.target_file_id?.slice(0, 8) || ''}`;
  const size     = proposed.size_bytes;
  const mime     = proposed.mime_type;
  const isFileBackedKind = item.kind === 'add' || item.kind === 'replace';

  const handlePreview = async () => {
    if (previewing) return;
    setPreviewing(true);
    try {
      const pendingPath = proposed.pending_storage_path;
      if (!pendingPath) return;
      const { data, error } = await createPendingSignedUrl(pendingPath, 300);
      if (error || !data?.signedUrl) return;
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <li className="change-requests-item">
      <span className={`change-requests-item-kind is-${item.kind}`}>
        {KIND_LABEL[item.kind] || item.kind}
      </span>
      <div className="change-requests-item-body">
        <div className="change-requests-item-name" title={fileName}>{fileName}</div>
        <div className="change-requests-item-meta">
          {mime && <span>{mime}</span>}
          {mime && size != null && <span aria-hidden="true">·</span>}
          {size != null && <span>{formatBytes(size)}</span>}
          {/* For edit: tease the changed fields. */}
          {item.kind === 'edit' && proposed.description !== undefined && (
            <span className="change-requests-item-edit-hint">description changed</span>
          )}
        </div>
      </div>
      {isFileBackedKind && proposed.pending_storage_path && (
        <button
          type="button"
          className="change-requests-item-preview"
          onClick={handlePreview}
          disabled={previewing}
        >
          {previewing ? 'Opening…' : 'Preview'}
        </button>
      )}
    </li>
  );
}

// Detail view — fetches the full request (items + meta) when an id
// is selected. Caches the last-fetched id so flipping quickly between
// list rows doesn't refetch.
function RequestDetail({ requestId, isAdmin, currentUserId, onClose, onAction }) {
  const { approveRequest, rejectRequest, withdrawRequest } = useBranch();
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [author, setAuthor] = useState(null);
  const [decider, setDecider] = useState(null);
  const [actionPending, setActionPending] = useState(false);
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectNote, setRejectNote] = useState('');

  useEffect(() => {
    if (!requestId) return undefined;
    let cancelled = false;
    setLoading(true);
    setFull(null);
    setAuthor(null);
    setDecider(null);
    setRejectMode(false);
    setRejectNote('');
    getChangeRequest(requestId).then(({ data, error }) => {
      if (cancelled || error) return;
      setFull(data);
      setLoading(false);
      if (data?.author_id) {
        fetchUploaderProfile(data.author_id).then(({ data: prof }) => {
          if (!cancelled) setAuthor(prof);
        });
      }
      if (data?.decided_by) {
        fetchUploaderProfile(data.decided_by).then(({ data: prof }) => {
          if (!cancelled) setDecider(prof);
        });
      }
    });
    return () => { cancelled = true; };
  }, [requestId]);

  if (!requestId) {
    return (
      <div className="change-requests-detail change-requests-detail-empty">
        <p>Select a request to review.</p>
      </div>
    );
  }
  if (loading || !full) {
    return (
      <div className="change-requests-detail change-requests-detail-empty">
        <p>Loading…</p>
      </div>
    );
  }

  const isAuthor = full.author_id === currentUserId;
  const isOpen   = full.status === 'open';
  const canApprove = isAdmin && isOpen;
  const canWithdraw = isAuthor && isOpen;

  const handleApprove = async () => {
    if (actionPending) return;
    setActionPending(true);
    const { error } = await approveRequest(requestId);
    setActionPending(false);
    if (!error) onAction?.();
  };
  const handleReject = async () => {
    if (actionPending) return;
    setActionPending(true);
    const { error } = await rejectRequest(requestId, rejectNote.trim() || null);
    setActionPending(false);
    if (!error) {
      setRejectMode(false);
      onAction?.();
    }
  };
  const handleWithdraw = async () => {
    if (actionPending) return;
    setActionPending(true);
    await withdrawRequest(requestId);
    setActionPending(false);
    onAction?.();
  };

  return (
    <div className="change-requests-detail">
      <header className="change-requests-detail-header">
        <div>
          <h3 className="change-requests-detail-title">{full.title}</h3>
          <div className="change-requests-detail-meta">
            <span className={`change-requests-status is-${full.status}`}>
              {STATUS_LABEL[full.status] || full.status}
            </span>
            <span>by {author?.full_name || author?.name || author?.email || 'Unknown'}</span>
            <span aria-hidden="true">·</span>
            <span>{formatRelative(full.submitted_at)}</span>
          </div>
        </div>
      </header>

      {full.description && (
        <p className="change-requests-detail-description">{full.description}</p>
      )}

      {full.status !== 'open' && full.decided_at && (
        <p className="change-requests-detail-decision">
          {STATUS_LABEL[full.status]} {formatRelative(full.decided_at)} by{' '}
          {decider?.full_name || decider?.name || decider?.email || 'Unknown'}
          {full.decision_note && (
            <>
              {' '}— <em>{full.decision_note}</em>
            </>
          )}
        </p>
      )}

      <ul className="change-requests-items">
        {full.items.map((it) => (
          <ItemRow key={it.id} item={it} />
        ))}
      </ul>

      {(canApprove || canWithdraw) && (
        <footer className="change-requests-detail-footer">
          {rejectMode ? (
            <>
              <input
                type="text"
                className="change-requests-reject-note"
                placeholder="Reason for rejection (optional)"
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                disabled={actionPending}
              />
              <button
                type="button"
                className="modal-btn modal-btn-cancel"
                onClick={() => { setRejectMode(false); setRejectNote(''); }}
                disabled={actionPending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn modal-btn-destructive"
                onClick={handleReject}
                disabled={actionPending}
              >
                {actionPending ? 'Rejecting…' : 'Reject'}
              </button>
            </>
          ) : (
            <>
              {canWithdraw && (
                <button
                  type="button"
                  className="modal-btn modal-btn-cancel"
                  onClick={handleWithdraw}
                  disabled={actionPending}
                >
                  Withdraw
                </button>
              )}
              {canApprove && (
                <>
                  <button
                    type="button"
                    className="modal-btn modal-btn-cancel"
                    onClick={() => setRejectMode(true)}
                    disabled={actionPending}
                  >
                    Reject…
                  </button>
                  <button
                    type="button"
                    className="modal-btn modal-btn-confirm"
                    onClick={handleApprove}
                    disabled={actionPending}
                  >
                    {actionPending ? 'Approving…' : 'Approve & merge'}
                  </button>
                </>
              )}
            </>
          )}
        </footer>
      )}
    </div>
  );
}

export default function ChangeRequestsPanel({ open, onClose }) {
  const { requests, isAdmin } = useBranch();
  const { session } = useAuth();
  const currentUserId = session?.user?.id || null;
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState('open'); // open | all

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Auto-pick the first visible request when the panel opens / the
  // filter changes, so the empty state isn't sticky.
  const visible = filter === 'open'
    ? requests.filter((r) => r.status === 'open')
    : requests;

  useEffect(() => {
    if (!open) return;
    if (!visible.find((r) => r.id === selectedId)) {
      setSelectedId(visible[0]?.id || null);
    }
  }, [open, visible, selectedId]);

  const handleAction = useCallback(() => {
    // After approve/reject/withdraw, the realtime echo will flip the
    // status — clear the selection so the list re-picks an open one.
    setSelectedId(null);
  }, []);

  if (!open) return null;

  const handleBackdropMouseDown = (e) => {
    if (e.target !== e.currentTarget) return;
    onClose?.();
  };

  return (
    <div
      className="change-requests-backdrop"
      onMouseDown={handleBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-requests-title"
    >
      <div className="change-requests-card">
        <header className="change-requests-header">
          <h2 id="change-requests-title" className="change-requests-title">
            Change requests
          </h2>
          <div className="change-requests-filter">
            <button
              type="button"
              className={`change-requests-filter-btn${filter === 'open' ? ' is-active' : ''}`}
              onClick={() => setFilter('open')}
            >
              Open
            </button>
            <button
              type="button"
              className={`change-requests-filter-btn${filter === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All
            </button>
          </div>
          <Tooltip content="Close">
            <button
              type="button"
              className="change-requests-close"
              onClick={onClose}
              aria-label="Close"
            >
              {CloseIcon}
            </button>
          </Tooltip>
        </header>

        <div className="change-requests-body">
          <aside className="change-requests-list">
            {visible.length === 0 ? (
              <div className="change-requests-empty">
                {filter === 'open' ? 'No open requests.' : 'No requests yet.'}
              </div>
            ) : visible.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`change-requests-list-item${selectedId === r.id ? ' is-active' : ''}`}
                onClick={() => setSelectedId(r.id)}
              >
                <div className="change-requests-list-item-title">{r.title}</div>
                <div className="change-requests-list-item-meta">
                  <span className={`change-requests-status is-${r.status}`}>
                    {STATUS_LABEL[r.status] || r.status}
                  </span>
                  <span>{formatRelative(r.submitted_at)}</span>
                </div>
              </button>
            ))}
          </aside>

          <RequestDetail
            requestId={selectedId}
            isAdmin={isAdmin}
            currentUserId={currentUserId}
            onClose={onClose}
            onAction={handleAction}
          />
        </div>
      </div>
    </div>
  );
}
