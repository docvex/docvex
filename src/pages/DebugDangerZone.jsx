import React, { useState } from 'react';
import DangerZone, { DangerRow } from '../components/DangerZone';
import { useNotify } from '../context/NotificationsContext';
import '../components/ConfirmModal.css';

// The Debug tab's danger zone (moved here from the removed Admin tab). Each
// action asks for its phrase to be typed before it runs. Like the Admin
// version, none of these reach the backend yet: confirming marks the row done
// and says what would have happened.
const ACTIONS = [
  { id: 'purge-db', title: 'Drop the entire database', owner: true, button: 'Drop database', confirm: 'DROP DATABASE', desc: 'Permanently truncate every table in the Supabase project — projects, members, notifications and legal updates.', consequences: ['Every table is truncated', 'Every user loses all of their projects and history', 'RLS policies and schema remain; only rows are deleted'], done: 'Database drop executed — all tables truncated.' },
  { id: 'empty-buckets', title: 'Empty all storage buckets', owner: true, button: 'Empty buckets', confirm: 'EMPTY BUCKETS', desc: 'Delete every object in the storage buckets. Rows pointing at them are left orphaned.', consequences: ['All stored objects are removed', 'Downloads and previews 404 until files are re-uploaded', 'Database rows are left intact (orphaned)'], done: 'Storage buckets emptied — all objects deleted.' },
  { id: 'revoke-sessions', title: 'Revoke all sessions', button: 'Revoke sessions', confirm: 'REVOKE', desc: 'Sign every user out across all devices and invalidate refresh tokens. Everyone must sign in again.', consequences: ['All refresh tokens are revoked server-side', 'Every signed-in user is logged out on next request', 'OAuth links remain; users just sign in again'], done: 'All sessions revoked — every user signed out.' },
  { id: 'rotate-keys', title: 'Rotate all API keys', owner: true, button: 'Rotate keys', confirm: 'ROTATE KEYS', desc: 'Roll the Supabase anon key, Resend and Anthropic secrets. Old keys stop working at once — a redeploy is required.', consequences: ['Supabase anon + service keys regenerated', 'RESEND_API_KEY and ANTHROPIC_API_KEY rolled', 'Edge Functions + clients must be redeployed with new secrets'], done: 'API keys rotated — redeploy with the new secrets.' },
  { id: 'nuke', title: 'Reset everything', owner: true, button: 'Reset everything', confirm: 'DELETE EVERYTHING', desc: 'Drop the database, empty storage, revoke every session and rotate all keys in one go.', consequences: ['Database truncated + storage emptied', 'All sessions revoked + API keys rotated', 'Every integration disconnected and reset'], done: 'Full reset executed — backend returned to an empty state.' },
];

function PhraseModal({ action, onConfirm, onCancel }) {
  const [text, setText] = useState('');
  const match = text.trim() === action.confirm;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="dbg-danger-title">
        <h3 id="dbg-danger-title" className="modal-title">{action.title}?</h3>
        <ul className="modal-message">
          {action.consequences.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <p className="modal-message">Type <b>{action.confirm}</b> to confirm.</p>
        <input
          className="dbg-danger-input"
          value={text}
          autoFocus
          spellCheck="false"
          placeholder={action.confirm}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
            if (e.key === 'Enter' && match) onConfirm(action);
          }}
        />
        <div className="modal-actions">
          <button type="button" className="modal-btn modal-btn-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="modal-btn modal-btn-destructive" disabled={!match} onClick={() => onConfirm(action)}>{action.button}</button>
        </div>
      </div>
    </div>
  );
}

export default function DebugDangerZone() {
  const { notify } = useNotify();
  const [pending, setPending] = useState(null);
  const [done, setDone] = useState({});
  const run = (action) => {
    setDone((d) => ({ ...d, [action.id]: true }));
    setPending(null);
    notify({ category: 'system', variant: 'warning', title: action.title, body: action.done, dedupeKey: `debug-danger-${action.id}` });
  };
  return (
    <>
      <DangerZone subtitle="Permanent, irreversible actions. Each one asks you to type a confirmation phrase.">
        {ACTIONS.map((a) => (
          <DangerRow key={a.id} title={a.owner ? `${a.title} · owner only` : a.title} desc={a.desc}>
            {done[a.id]
              ? <span className="dbg-danger-done">Done</span>
              : <button type="button" className="dz-btn" onClick={() => setPending(a)}>{a.button}</button>}
          </DangerRow>
        ))}
      </DangerZone>
      {pending && <PhraseModal action={pending} onConfirm={run} onCancel={() => setPending(null)} />}
    </>
  );
}
