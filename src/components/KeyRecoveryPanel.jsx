import React, { useEffect, useState } from 'react';
import {
  ensureIdentity, identityState, subscribeIdentity, hasRecoveryBackup,
  saveRecoveryBackup, restoreIdentity, resetIdentity,
} from '../lib/e2e/identity';
import { MIN_PASSPHRASE } from '../lib/e2e/identityCore';
import { fingerprint } from '../lib/e2e/primitives';
import './DangerZone.css';
import './KeyRecoveryPanel.css';

// ENCRYPTION KEYS — this device's end-to-end identity (lib/e2e/identity):
// its state, its fingerprint, the recovery passphrase, and restoring or (last
// resort) replacing the keys. Meant for the Account page, under a heading of
// its own; self-contained, it takes no props.

const MESSAGES = {
  wrong_passphrase: 'That passphrase does not open the recovery copy.',
  no_backup: 'There is no recovery copy in your account.',
  passphrase_too_short: `Use at least ${MIN_PASSPHRASE} characters.`,
  backup_is_not_the_published_key: 'The recovery copy is older than the keys your account uses now.',
  vault_unavailable: 'This computer has no safe place for private keys — restart DocVex after updating it.',
  no_encryption: 'This computer’s system keychain is not available, so private keys can’t be kept safely.',
};
const say = (err) => MESSAGES[err?.message] || err?.message || String(err);

export default function KeyRecoveryPanel() {
  const [st, setSt] = useState(identityState());
  const [fp, setFp] = useState(null);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [armReset, setArmReset] = useState(false);

  useEffect(() => {
    const off = subscribeIdentity(setSt);
    ensureIdentity().then(async (id) => {
      if (id) setFp(await fingerprint(id.x25519.publicRaw));
      hasRecoveryBackup().catch(() => {});
    });
    return off;
  }, []);

  const run = async (fn, ok) => {
    setBusy(true); setNote(null);
    try {
      const id = await fn();
      if (id?.x25519) setFp(await fingerprint(id.x25519.publicRaw));
      setNote({ tone: 'ok', text: ok }); setPass(''); setPass2('');
    } catch (err) { setNote({ tone: 'err', text: say(err) }); }
    setBusy(false);
  };

  const status = st.status;
  return (
    <section className="krp">
      <p className="krp-lead">
        Your projects’ files, chats and names are encrypted on this device with keys only you and your
        project members hold. DocVex’s servers cannot read them — and cannot recover them for you.
      </p>
      <div className="krp-row">
        <span className={`krp-pill is-${status === 'ready' ? 'ok' : (status === 'unknown' ? 'idle' : 'warn')}`}>
          {status === 'ready' ? 'Keys on this device'
            : status === 'needs-recovery' ? 'Keys needed on this device'
              : status === 'mismatch' ? 'Out-of-date keys on this device'
                : status === 'unavailable' ? 'No safe key storage'
                  : status === 'signed-out' ? 'Signed out' : 'Checking…'}
        </span>
        {fp && status === 'ready' && <code className="krp-fp">{fp}</code>}
      </div>

      {status === 'ready' && (
        <div className="krp-block">
          <h3>{st.hasBackup ? 'Change the recovery passphrase' : 'Set a recovery passphrase'}</h3>
          <p>You need it to open your projects on another computer, or after reinstalling. Keep it somewhere safe.</p>
          <input type="password" className="krp-input" placeholder={`Passphrase (${MIN_PASSPHRASE}+ characters)`} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          <input type="password" className="krp-input" placeholder="Repeat it" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
          <button type="button" className="krp-btn" disabled={busy || pass.length < MIN_PASSPHRASE || pass !== pass2}
            onClick={() => run(() => saveRecoveryBackup(pass), 'Recovery copy saved.')}>
            Save recovery copy
          </button>
        </div>
      )}

      {(status === 'needs-recovery' || status === 'mismatch') && (
        <div className="krp-block">
          <h3>Restore your keys</h3>
          <p>Enter the recovery passphrase you set on your other computer.</p>
          <input type="password" className="krp-input" placeholder="Recovery passphrase" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
          <button type="button" className="krp-btn" disabled={busy || !pass}
            onClick={() => run(() => restoreIdentity(pass), 'Keys restored.')}>
            Restore
          </button>
          <div className="krp-reset">
            <p>Lost the passphrase? New keys can be made — every project must then be granted to you again by another member, and what only you could read is lost.</p>
            <button type="button" className="dz-btn krp-danger" disabled={busy}
              onClick={() => { if (!armReset) { setArmReset(true); return; } setArmReset(false); run(() => resetIdentity(), 'New keys made. Ask a project admin to open each project.'); }}>
              {armReset ? 'Press again to replace the keys' : 'Make new keys'}
            </button>
          </div>
        </div>
      )}

      {note && <p className={`krp-note is-${note.tone}`}>{note.text}</p>}
      {st.error && status !== 'ready' && <p className="krp-note is-err">{say({ message: st.error })}</p>}
    </section>
  );
}
