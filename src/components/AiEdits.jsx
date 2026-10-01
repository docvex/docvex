import { useState } from 'react';
import { applyProposal, canApply, canUndo, discardProposal, runUndo } from '../lib/aiFileEdits';
import './AiChoices.css';

// What an AI reply PROPOSES to change in the project's files (lib/aiFileEdits):
// one row per file — its name and the changes, or why it can't be done — with
// Apply / Discard. Nothing is written before Apply (V4); once applied, Undo
// while this session still holds the file's previous bytes. A legacy message
// (edits applied on arrival, before approval existed) still shows as Edited.
export default function AiEdits({ edits }) {
  // Per row: 'applied' | 'discarded' | 'undone' | { error }
  const [state, setState] = useState({});
  const [undoKeys, setUndoKeys] = useState({});
  const [busy, setBusy] = useState(-1);
  if (!edits?.length) return null;

  const run = async (i, fn) => {
    setBusy(i);
    try { await fn(); } finally { setBusy(-1); }
  };

  return (
    <div className="ai-edits" role="status">
      {edits.map((e, i) => {
        const st = state[i];
        const proposed = e.status === 'proposed';
        const failed = e.error || (st && typeof st === 'object' && st.error);
        const undoKey = undoKeys[i] || (!proposed ? e.undoKey : null);
        let label;
        if (e.error) label = 'Not changed';
        else if (st === 'discarded') label = 'Discarded';
        else if (st === 'undone') label = 'Undone';
        else if (st === 'applied' || !proposed) label = 'Edited';
        else if (failed) label = 'Not applied';
        else if (!canApply(e.proposalKey)) label = 'Expired';
        else label = 'Proposed';
        const pending = proposed && !st && canApply(e.proposalKey) && !e.error;
        return (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className={`ai-edit${failed ? ' is-error' : ''}${st === 'undone' || st === 'discarded' ? ' is-undone' : ''}`}>
            <div className="ai-edit-head">
              <span className="ai-edit-file">{e.file}</span>
              <span className="ai-edit-state">{label}</span>
              {pending && (
                <>
                  <button
                    type="button"
                    className="ai-edit-undo"
                    disabled={busy === i}
                    onClick={() => run(i, async () => {
                      const r = await applyProposal(e.proposalKey);
                      if (r.ok) { setUndoKeys((m) => ({ ...m, [i]: r.undoKey })); setState((m) => ({ ...m, [i]: 'applied' })); } else setState((m) => ({ ...m, [i]: { error: r.error } }));
                    })}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="ai-edit-undo"
                    disabled={busy === i}
                    onClick={() => { discardProposal(e.proposalKey); setState((m) => ({ ...m, [i]: 'discarded' })); }}
                  >
                    Discard
                  </button>
                </>
              )}
              {!e.error && (st === 'applied' || !proposed) && st !== 'undone' && canUndo(undoKey) && (
                <button
                  type="button"
                  className="ai-edit-undo"
                  disabled={busy === i}
                  onClick={() => run(i, async () => { if (await runUndo(undoKey)) setState((m) => ({ ...m, [i]: 'undone' })); })}
                >
                  Undo
                </button>
              )}
            </div>
            {e.error
              ? <div className="ai-edit-line">{e.error}</div>
              : (e.changes || []).map((c, k) => <div key={k} className="ai-edit-line">{c}</div>)}
            {st && typeof st === 'object' && st.error ? <div className="ai-edit-line">{st.error}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
