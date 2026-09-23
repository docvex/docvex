import React, { useEffect, useRef, useState } from 'react';
import './ConfirmModal.css';
import './ConvertModal.css';

// ── Converting a document ───────────────────────────────────────────────────
// A conversion WRITES A NEW FILE into the project, and until now it did that
// the moment the button was pressed, with a name the app chose. Two things were
// wrong with that: a conversion is not free — rebuilding a PDF as Word reads
// every page, and every page of a scan is read by the AI — so it deserves the
// beat a dialog gives it; and the name matters, because the result lands beside
// the original and "contract.docx" next to "contract.pdf" says nothing about
// which is which.
//
// So the button opens this: what the conversion IS (the action's own glyph,
// carried in so the dialog and the button that opened it are plainly the same
// thing), what it will and won't carry across, and the name — filled in and
// SELECTED, so it can be accepted with Enter or typed straight over.
export default function ConvertModal({
  open,
  icon,
  title,
  explain,
  // What the name will be given when it is written, shown after the field so
  // the extension is visible without being editable (and so it cannot be typed
  // away by accident).
  suffix = '',
  defaultName = '',
  confirmLabel = 'Convert',
  busy = false,
  onConfirm,
  onCancel,
}) {
  const [name, setName] = useState(defaultName);
  const inputRef = useRef(null);

  // A fresh open starts from the suggested name again — the last one may have
  // been typed over, or abandoned.
  useEffect(() => { if (open) setName(defaultName); }, [open, defaultName]);

  // Selected, not just focused: the suggestion is a proposal, and the fastest
  // way to reject a proposal is to type over it.
  useEffect(() => {
    if (!open) return undefined;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const clean = name.trim();
  const go = () => { if (clean && !busy) onConfirm?.(clean); };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel?.(); }}
    >
      <div className="modal-card cvm-card" role="dialog" aria-modal="true" aria-labelledby="cvm-title">
        <div className="cvm-head">
          <span className="cvm-icon" aria-hidden="true">{icon}</span>
          <div className="cvm-head-text">
            <h3 id="cvm-title" className="modal-title cvm-title">{title}</h3>
            {explain && <p className="cvm-explain">{explain}</p>}
          </div>
        </div>

        <label className="cvm-field">
          <span className="cvm-label">Save as</span>
          <span className="cvm-input-wrap">
            <input
              ref={inputRef}
              className="cvm-input"
              value={name}
              spellCheck={false}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }}
            />
            {suffix && <span className="cvm-suffix" aria-hidden="true">{suffix}</span>}
          </span>
        </label>

        <div className="modal-actions">
          <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn modal-btn-confirm"
            onClick={go}
            disabled={!clean || busy}
          >
            {busy ? 'Converting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
