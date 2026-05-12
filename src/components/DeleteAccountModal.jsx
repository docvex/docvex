import React, { useEffect, useRef, useState } from 'react';
// Reuses the shared modal backdrop/card/button styles + the
// type-to-confirm input + label/name pill styles from DeleteProjectModal.
// We're not subclassing DeleteProjectModal directly because its copy is
// specific to a project (warning text mentions members/invites/files),
// and a thin wrapper would have hardly any code in common.
import './ConfirmModal.css';
import './DeleteProjectModal.css';

// GitHub-style "type your email to confirm" dialog for permanent account
// deletion. Disables the destructive button until the typed value matches
// the user's email (trimmed on both sides), mirroring DeleteProjectModal's
// gating contract so the muscle memory is identical.
//
// Props:
//   open       — boolean; mount the dialog when true
//   email      — the exact email the caller must type to enable Delete
//   onConfirm  — called when the user clicks the now-enabled Delete button
//   onCancel   — called on Esc, backdrop click, or Cancel button
//   pending    — disables every interactive control during the network call;
//                also blocks Esc + backdrop dismissal so a request in flight
//                can't be silently abandoned
export default function DeleteAccountModal({
  open,
  email,
  onConfirm,
  onCancel,
  pending = false,
}) {
  const [confirmText, setConfirmText] = useState('');
  const inputRef = useRef(null);

  // Reset on every open + focus the input — same UX as DeleteProjectModal
  // so the two destructive flows feel identical to the user.
  useEffect(() => {
    if (open) {
      setConfirmText('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !pending) onCancel?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, pending, onCancel]);

  if (!open) return null;

  const expected = (email ?? '').trim();
  const matches = confirmText.trim().toLowerCase() === expected.toLowerCase() && expected.length > 0;

  const handleBackdropMouseDown = (e) => {
    if (pending) return;
    if (e.target === e.currentTarget) onCancel?.();
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!matches || pending) return;
    onConfirm?.();
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        className="modal-card delete-project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-modal-title"
      >
        <h3 id="delete-account-modal-title" className="modal-title">
          Delete your account?
        </h3>
        <p className="modal-message">
          This action <strong>cannot be undone</strong>. Your account, project
          memberships, and notifications will be permanently removed. Projects
          you own will lose their owner — co-admins (if any) will keep access,
          but solo-owner projects will be orphaned. Pending invitations you
          sent will also be cleared.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="delete-account-confirm-input" className="delete-project-label">
            Please type <span className="delete-project-name">{expected}</span> to confirm.
          </label>
          <input
            id="delete-account-confirm-input"
            ref={inputRef}
            type="text"
            className="delete-project-input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
          />

          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn-cancel"
              onClick={onCancel}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal-btn modal-btn-destructive"
              disabled={!matches || pending}
            >
              {pending ? 'Deleting…' : 'Delete account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
