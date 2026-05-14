import React, { useEffect, useRef, useState } from 'react';
// Reuse the modal backdrop/card/button styles from ConfirmModal, plus the
// type-to-confirm input + label styling from DeleteProjectModal — the two
// dialogs look the same except for the copy and the field they're matching
// against. Co-locating both imports here keeps the styles available without
// duplicating any rule definitions.
import './ConfirmModal.css';
import './DeleteProjectModal.css';

// Type-to-confirm "remove member" dialog. Same shape as DeleteProjectModal:
// the destructive button stays disabled until `confirmText.trim() === memberName.trim()`
// — explicit-enough friction to prevent misclicks on a populated list,
// matching how project-delete already feels.
//
// Note: an in-flight RLS rejection (e.g. role demoted between page load and
// click) is surfaced inline via the `error` prop; the parent keeps the modal
// open so the user can read what went wrong instead of the toast flashing
// past on a closing modal. Mirrors the inline-error pattern from
// FileDetailModal's delete-confirm sub-modal.
//
// Props:
//   open         — boolean; mount the dialog when true
//   memberName   — display name the user must type to enable Remove
//   projectName  — shown in the body copy for context ("from {projectName}")
//   error        — optional string; rendered as an inline error banner
//   onConfirm    — called when the user clicks the enabled Remove button
//   onCancel     — called on Esc, backdrop click, or Cancel button
//   pending      — disables every interactive control during the network call;
//                  also blocks Esc + backdrop dismissal so a request in flight
//                  can't be silently abandoned
export default function RemoveMemberModal({
  open,
  memberName,
  projectName,
  error,
  onConfirm,
  onCancel,
  pending = false,
}) {
  const [confirmText, setConfirmText] = useState('');
  const inputRef = useRef(null);

  // Reset the typed text every time the modal opens — a stale value from a
  // previous open shouldn't pre-arm the Remove button. Defer focus so the
  // input is in the DOM before we focus() it.
  useEffect(() => {
    if (open) {
      setConfirmText('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Esc dismisses unless we're mid-request. Same idiom as DeleteProjectModal.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !pending) onCancel?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, pending, onCancel]);

  if (!open) return null;

  const expected = (memberName ?? '').trim();
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
        aria-labelledby="remove-member-modal-title"
      >
        <h3 id="remove-member-modal-title" className="modal-title">
          Remove member?
        </h3>
        <p className="modal-message">
          <strong>{expected || 'This member'}</strong> will lose access to
          {projectName ? <> <strong>{projectName}</strong>'s</> : ' this project\'s'}
          {' '}files and chat. They can be re-invited later.
        </p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="remove-member-confirm-input" className="delete-project-label">
            Please type <span className="delete-project-name">{expected}</span> to confirm.
          </label>
          <input
            id="remove-member-confirm-input"
            ref={inputRef}
            type="text"
            className="delete-project-input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
          />

          {/* Inline error — uses the shared `.modal-inline-error` class
              from ConfirmModal.css so both themes (Cream and Ink) get a
              correctly-colored red wash, instead of the hardcoded literal
              red that this modal used to inline via style={{ ... }}. */}
          {error && (
            <div role="alert" className="modal-inline-error">
              {error}
            </div>
          )}

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
              {pending ? 'Removing…' : 'Remove member'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
