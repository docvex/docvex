import { useState } from 'react';
import { canUndo, runUndo } from '../lib/aiFileEdits';
import './AiChoices.css';

// What an AI reply CHANGED in the project's files (lib/aiFileEdits): one row
// per file — its name, the changes, or why it could not be done — with Undo
// while this session still holds the file's previous bytes.
export default function AiEdits({ edits }) {
  const [undone, setUndone] = useState({});
  const [busy, setBusy] = useState('');
  if (!edits?.length) return null;
  return (
    <div className="ai-edits" role="status">
      {edits.map((e, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className={`ai-edit${e.error ? ' is-error' : ''}${undone[i] ? ' is-undone' : ''}`}>
          <div className="ai-edit-head">
            <span className="ai-edit-file">{e.file}</span>
            <span className="ai-edit-state">{e.error ? 'Not changed' : undone[i] ? 'Undone' : 'Edited'}</span>
            {!e.error && !undone[i] && canUndo(e.undoKey) && (
              <button
                type="button"
                className="ai-edit-undo"
                disabled={busy === e.undoKey}
                onClick={async () => {
                  setBusy(e.undoKey);
                  try { if (await runUndo(e.undoKey)) setUndone((m) => ({ ...m, [i]: true })); } finally { setBusy(''); }
                }}
              >
                Undo
              </button>
            )}
          </div>
          {e.error
            ? <div className="ai-edit-line">{e.error}</div>
            : (e.changes || []).map((c, k) => <div key={k} className="ai-edit-line">{c}</div>)}
        </div>
      ))}
    </div>
  );
}
