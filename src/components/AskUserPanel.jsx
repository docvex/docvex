import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import './AskUserPanel.css';

// Interactive controls for the `ask_user` tool — rendered ABOVE the composer in
// every AI chat. Claude calls ask_user with up to 3 questions; this panel
// collects the answers and hands them back via onSubmit (the §4 answers shape,
// built by makeAskAnswers in lib/projectAi). Once answered it locks and shows
// the chosen values so the chat history stays coherent on reload.
//
// Props:
//   questions  — askUser.input.questions: [{ id, prompt, response_type, options? }]
//   locked     — render read-only (already answered)
//   resolved   — the answers object to display when locked
//   onSubmit(perQuestion) — perQuestion keyed by id → ids[] | string | boolean
//   onDismiss() — optional "skip / cancel"
//   composerInput — free_text answers are typed in the host's existing message
//                   box (not a textarea here); when every question is free_text
//                   the composer also submits, so this panel hides its Submit.
//   actionsSlot — when given, the Submit/Skip row is portalled into this node
//                 (the composer toolbar) instead of rendering inside the panel.
//   hideActions — render no Submit/Skip row (the host composer provides them).
export default function AskUserPanel({ questions = [], locked = false, resolved = null, onSubmit, onDismiss, composerInput = false, actionsSlot = null, hideActions = false }) {
  const [sel, setSel] = useState({});

  const lockedSel = useMemo(() => {
    const map = {};
    (resolved?.answers || []).forEach((a) => {
      if (a.response_type === 'free_text') map[a.question_id] = a.text;
      else if (a.response_type === 'confirm') map[a.question_id] = a.approved;
      else map[a.question_id] = a.selected || [];
    });
    return map;
  }, [resolved]);

  const cur = locked ? lockedSel : sel;
  const setOne = (id, v) => setSel((s) => ({ ...s, [id]: v }));

  const valid = useMemo(() => questions.every((q) => {
    const v = sel[q.id];
    if (q.response_type === 'single_select') return Array.isArray(v) ? v.length === 1 : v != null;
    if (q.response_type === 'confirm') return typeof v === 'boolean';
    return true; // multi_select & free_text optional
  }), [questions, sel]);

  // Single-question selects/confirms submit on click for a snappy feel.
  const single = questions.length === 1 ? questions[0] : null;
  const autoSubmit = single && (single.response_type === 'single_select' || single.response_type === 'confirm');
  // When reusing the composer and every question is free_text, the host's send
  // button is the submit — hide this panel's Submit (keep only Skip).
  const allFreeText = questions.length > 0 && questions.every((q) => q.response_type === 'free_text');
  const composerSubmits = composerInput && allFreeText;

  const submit = (override) => { if (onSubmit) onSubmit(override || sel); };

  // The Submit / Skip row (or Skip-only for auto/composer-submit cases). May be
  // rendered inline, portalled into the composer toolbar (actionsSlot), or
  // omitted entirely (hideActions — the host composer provides them).
  const actionsEl = locked ? null
    : (!autoSubmit && !composerSubmits) ? (
        <div className="ask-actions">
          {onDismiss && <button type="button" className="ask-skip" onClick={onDismiss}>Skip</button>}
          <button type="button" className="ask-submit" disabled={!valid} onClick={() => submit()}>Submit</button>
        </div>
      )
    : (onDismiss ? (
        <div className="ask-actions ask-actions--skiponly"><button type="button" className="ask-skip" onClick={onDismiss}>Skip</button></div>
      ) : null);

  const confirmButtons = (q) => (q.options && q.options.length >= 2
    ? [{ ...q.options[0], v: true }, { ...q.options[1], v: false }]
    : [{ id: '_yes', label: 'Approve', v: true }, { id: '_no', label: 'Decline', v: false }]);

  return (
    <div className={`ask-panel${locked ? ' is-locked' : ''}`} role="group" aria-label="Questions from the assistant">
      {questions.map((q) => {
        const v = cur[q.id];
        return (
          <div className="ask-q" key={q.id}>
            <p className="ask-q-prompt">{q.prompt}</p>

            {q.response_type === 'single_select' && (
              <div className="ask-opts ask-opts--stack" role="radiogroup">
                {(q.options || []).map((o) => {
                  const on = Array.isArray(v) ? v.includes(o.id) : v === o.id;
                  return (
                    <button
                      key={o.id} type="button" role="radio" aria-checked={on}
                      className={`ask-opt${on ? ' is-on' : ''}`}
                      disabled={locked}
                      onClick={() => (autoSubmit ? submit({ [q.id]: [o.id] }) : setOne(q.id, [o.id]))}
                      title={o.description || ''}
                    >
                      <span className="ask-opt-label">{o.label}</span>
                      {o.description && <span className="ask-opt-desc">{o.description}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {q.response_type === 'multi_select' && (
              <div className="ask-opts ask-opts--stack">
                {(q.options || []).map((o) => {
                  const arr = Array.isArray(v) ? v : [];
                  const on = arr.includes(o.id);
                  return (
                    <button
                      key={o.id} type="button" role="checkbox" aria-checked={on}
                      className={`ask-opt is-check${on ? ' is-on' : ''}`}
                      disabled={locked}
                      onClick={() => setOne(q.id, on ? arr.filter((x) => x !== o.id) : [...arr, o.id])}
                      title={o.description || ''}
                    >
                      <span className="ask-check-box" aria-hidden="true" />
                      <span className="ask-opt-label">{o.label}</span>
                      {o.description && <span className="ask-opt-desc">{o.description}</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {q.response_type === 'confirm' && (
              <div className="ask-opts">
                {confirmButtons(q).map((b) => {
                  const on = typeof v === 'boolean' && v === b.v;
                  return (
                    <button
                      key={b.id} type="button"
                      className={`ask-opt is-confirm ${b.v ? 'is-yes' : 'is-no'}${on ? ' is-on' : ''}`}
                      disabled={locked}
                      onClick={() => (autoSubmit ? submit({ [q.id]: b.v }) : setOne(q.id, b.v))}
                    >
                      <span className="ask-opt-label">{b.label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {q.response_type === 'free_text' && (
              composerInput && !locked ? (
                <p className="ask-free-hint">Type your answer in the message box below.</p>
              ) : (
                <textarea
                  className="ask-free"
                  rows={2}
                  value={locked ? (v || '') : (sel[q.id] || '')}
                  disabled={locked}
                  placeholder="Type your answer…"
                  onChange={(e) => setOne(q.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (valid) submit(); } }}
                />
              )
            )}
          </div>
        );
      })}

      {!hideActions && !actionsSlot && actionsEl}
      {!hideActions && actionsSlot && actionsEl && createPortal(actionsEl, actionsSlot)}
    </div>
  );
}
