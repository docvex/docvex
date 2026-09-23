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
// One button opens it, whatever the file can become: the TARGETS are chosen
// here rather than on the Quick actions card. A pane that offers several
// conversions used to spend a tile on each of them, under a "Convert" heading
// of their own — three tiles saying the same verb. The verb is one action; the
// target is a choice, and a choice belongs in the dialog that is already asking
// for the name. Each target carries its own wording, glyph and extension, so
// picking one re-describes the dialog around it.
export default function ConvertModal({
  open,
  icon,
  title,
  explain,
  // [{ id, label, icon, title, explain, suffix, name }] — what this file can
  // become. Left out, the four props above describe a single conversion.
  targets = null,
  initialTarget = null,
  // { label, icon } — the format the file is NOW, shown at the left of the
  // flow. Without it the flow is just the target.
  from = null,
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
  const list = Array.isArray(targets) && targets.length ? targets : null;
  const [pick, setPick] = useState(() => initialTarget || list?.[0]?.id || null);
  // A fresh open starts from the target it was opened ON (the button may name
  // one), not from whatever was chosen last time.
  useEffect(() => { if (open) setPick(initialTarget || list?.[0]?.id || null); }, [open, initialTarget]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = list ? (list.find((t) => t.id === pick) || list[0]) : null;

  // The chosen target describes the dialog; without one the props do.
  const shownIcon = chosen?.icon ?? icon;
  const shownTitle = chosen?.title ?? title;
  const shownExplain = chosen?.explain ?? explain;
  const shownSuffix = chosen?.suffix ?? suffix;
  const shownName = chosen?.name ?? defaultName;

  const [name, setName] = useState(shownName);
  const inputRef = useRef(null);

  // A fresh open starts from the suggested name again — the last one may have
  // been typed over, or abandoned — and so does a change of target, whose
  // suggestion names the format it is going to.
  useEffect(() => { if (open) setName(shownName); }, [open, shownName]);

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
  const go = () => { if (clean && !busy) onConfirm?.(clean, chosen?.id ?? null); };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel?.(); }}
    >
      <div className="modal-card cvm-card" role="dialog" aria-modal="true" aria-labelledby="cvm-title">
        <div className="cvm-head">
          {!list && <span className="cvm-icon" aria-hidden="true">{shownIcon}</span>}
          <div className="cvm-head-text">
            <h3 id="cvm-title" className="modal-title cvm-title">{shownTitle}</h3>
            {shownExplain && <p className="cvm-explain">{shownExplain}</p>}
          </div>
        </div>

        {list && (
          /* What the file is now → what it becomes. The choice sits UNDER the
             arrow, between the two formats it is turning, so the sentence the
             row makes reads left to right: this, into that. */
          <div className="cvm-flow">
            {from && (
              <div className="cvm-fmt">
                <span className="cvm-fmt-icon" aria-hidden="true">{from.icon}</span>
                <span className="cvm-fmt-label">{from.label}</span>
              </div>
            )}
            <div className="cvm-turn">
              <span className="cvm-arrow" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12h15" /><path d="M14 7l5 5-5 5" />
                </svg>
              </span>
              <span className="cvm-select-wrap">
                <select
                  className="cvm-select"
                  value={chosen?.id ?? ''}
                  disabled={busy || list.length < 2}
                  aria-label="Convert to"
                  onChange={(e) => setPick(e.target.value)}
                >
                  {list.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </span>
            </div>
            <div className="cvm-fmt is-target">
              <span className="cvm-fmt-icon" aria-hidden="true">{shownIcon}</span>
              <span className="cvm-fmt-label">{chosen?.label}</span>
            </div>
          </div>
        )}

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
            {shownSuffix && <span className="cvm-suffix" aria-hidden="true">{shownSuffix}</span>}
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
