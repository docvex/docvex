import React, { useEffect, useRef, useState } from 'react';
// Reuse the modal backdrop/card/button styles from ConfirmModal so this
// dialog matches the rest of the app's destructive modals; the typing-input
// + label styling lives in DeleteProjectModal.css alongside it.
import './ConfirmModal.css';
import './DeleteProjectModal.css';

// GitHub-style "type the project name to confirm" delete dialog. The button
// stays disabled until `confirmText.trim() === projectName.trim()` — matching
// trim semantics with how project names are stored (trimmed on insert via the
// projects_name_check constraint).
//
// Props:
//   open         — boolean; mount the dialog when true
//   projectName  — the exact string the user must type to enable Delete
//   onConfirm    — called when the user clicks the now-enabled Delete button
//   onCancel     — called on Esc, backdrop click, or Cancel button
//   pending      — disables every interactive control during the network call;
//                  also blocks Esc + backdrop dismissal so a request in flight
//                  can't be silently abandoned
export default function DeleteProjectModal({
  open,
  projectName,
  onConfirm,
  onCancel,
  pending = false,
}) {
  const [confirmText, setConfirmText] = useState('');
  const inputRef = useRef(null);

  // Reset the typed text every time the modal opens so a stale value from a
  // previous open doesn't pre-arm the Delete button. Also focus the input on
  // open — the whole point of this dialog is for the user to type into it.
  useEffect(() => {
    if (open) {
      setConfirmText('');
      // Defer focus to after the element is in the DOM
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Esc dismisses, but only when not pending — mirrors ConfirmModal.jsx.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !pending) onCancel?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, pending, onCancel]);

  if (!open) return null;

  const expected = (projectName ?? '').trim();
  const matches = confirmText.trim() === expected && expected.length > 0;

  // Backdrop click only dismisses when the click *started* on the backdrop —
  // prevents accidental dismissal when the user mouse-downs inside the card
  // and releases outside it. Same idiom as ConfirmModal.handleBackdropMouseDown.
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
        aria-labelledby="delete-project-modal-title"
      >
        <h3 id="delete-project-modal-title" className="modal-title">
          Delete this project?
        </h3>
        <p className="modal-message">
          This action <strong>cannot be undone</strong>. Deleting this project
          will permanently remove its member list, pending invitations, and
          uploaded files.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="delete-project-confirm-input" className="delete-project-label">
            Please type <span className="delete-project-name">{expected}</span> to confirm.
          </label>
          <input
            id="delete-project-confirm-input"
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
              {pending ? 'Deleting…' : 'Delete project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
