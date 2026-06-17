import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { PLAN } from '../lib/plan';
import { supabase } from '../lib/supabaseClient';
import '../components/ConfirmModal.css'; // modal-* classes for the password modal
import DangerZone, { DangerRow } from '../components/DangerZone';
import StatusBadge from '../components/StatusBadge';
import Tooltip from '../components/Tooltip';
import { STATUS_OPTIONS, DEFAULT_STATUS_KEY, updateStatus } from '../lib/userStatus';
import './Account.css';

function formatDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

const CopyIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);

const CheckIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const MailIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>
  </svg>
);

// The official Google "G" logo — same shape as AuthPage's "Continue with
// Google" button so the link-Google pill reads as the same affordance.
// Component form (not a const) so the colors aren't affected by parent
// currentColor like the other stroke icons in this file.
function GoogleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
      <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
    </svg>
  );
}

// In-card danger-zone confirmations. Each danger button morphs the card into
// the matching confirmation (see the `.dz-confirm` overlay below). `delete`
// adds a type-your-email gate before the button enables.
const DZ_CONFIRMS = {
  signout: {
    title: 'Sign out?',
    message: "You'll need to sign in again to access your account.",
    confirmLabel: 'Sign out',
    busyLabel: 'Signing out…',
  },
  erase: {
    title: 'Erase all account data?',
    message: 'This signs you out from every device and removes locally cached account data. You can sign back in afterwards, but anything stored only on this machine will be gone.',
    confirmLabel: 'Erase everything',
    busyLabel: 'Erasing…',
  },
  delete: {
    title: 'Delete your account?',
    message: 'This cannot be undone. Your account, project memberships, and notifications are permanently removed; projects you solely own are orphaned and pending invitations you sent are cleared.',
    confirmLabel: 'Delete account',
    busyLabel: 'Deleting…',
    requireEmail: true,
  },
};

export default function Account() {
  const { session, logout, eraseData, deleteAccount, linkGoogle, setPassword } = useAuth();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  // In-card danger-zone confirmation: the active action ('signout' | 'erase' |
  // 'delete' | null), an exit-animation flag (so cancel animates out, not just
  // unmounts), the type-to-confirm email (delete only), and a busy flag while
  // the action runs.
  const [dzKind, setDzKind] = useState(null);
  const [dzClosing, setDzClosing] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkingGoogle, setLinkingGoogle] = useState(false);
  // Set-a-password form state. Lives on this page (vs a modal) so the
  // user can see the surrounding "Account information" context — they
  // typically come here looking for it after running into "I can only
  // sign in with Google".
  const [pwForm, setPwForm] = useState({ next: '', confirm: '', show: false });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState(null);
  // For accounts that already have a password, the change-password card is
  // hidden until the user clicks "Reset password" in the danger zone.
  const [showReset, setShowReset] = useState(false);
  // Authoritative "does this account have a password?" — comes from a
  // SECURITY DEFINER RPC reading auth.users.encrypted_password, because a
  // password set on a Google account leaves NO trace in identities/providers.
  // null = still loading.
  const [serverHasPassword, setServerHasPassword] = useState(null);
  // Optimistic override for the active status — held locally so the UI
  // reflects the click immediately while supabase-js's USER_UPDATED event
  // round-trips. Cleared once the session's user_metadata catches up.
  const [pendingStatus, setPendingStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);

  // ProtectedRoute should prevent us getting here without a session,
  // but guard anyway in case StrictMode renders during the redirect.
  if (!session) return null;

  const user = session.user;
  // `app_metadata.provider` is the user's *primary* (most recent) sign-in
  // method; we use it for the legacy "Email"/"Google" headline pill below.
  // For the link-Google affordance we need the FULL list of linked identities,
  // not just the primary — Supabase exposes it under `user.identities`.
  const provider = user.app_metadata?.provider || 'email';
  // Linked auth methods. `app_metadata.providers` is the authoritative list in
  // the JWT; `user.identities` is a secondary source that isn't always
  // populated (notably right after setting a password). Union both so the
  // password/Google detection below stays correct across sessions.
  const linkedProviders = new Set([
    ...((user.identities || []).map((i) => i.provider)),
    ...(user.app_metadata?.providers || []),
  ]);
  const googleLinked = linkedProviders.has('google');
  // Whether the account has an email+password. The identity/provider list is
  // only a hint (it's empty for a password set on a Google account); the
  // server RPC is authoritative. `pwKnown` gates the UI until we know, so the
  // "Set a password" card doesn't flash for someone who already has one.
  const identityHasPassword = linkedProviders.has('email');
  const hasPassword = identityHasPassword || serverHasPassword === true;
  const pwKnown = identityHasPassword || serverHasPassword !== null;
  const avatarUrl = user.user_metadata?.avatar_url;
  // Mirrors getDisplayName() in Sidebar.jsx — kept in sync per the
  // CLAUDE.md convention. Strips the @domain when falling back to email so
  // the name reads cleanly ("petreluca1105" instead of "petreluca1105@gmail.com").
  // The full email still appears elsewhere on this page in the identity panel.
  const displayName =
    user.user_metadata?.full_name
    || user.user_metadata?.name
    || (user.email ? user.email.split('@')[0] : null)
    || 'Account';
  const initials = (user.email || '?').charAt(0).toUpperCase();
  const activeStatus = pendingStatus || user.user_metadata?.status || DEFAULT_STATUS_KEY;

  const handleStatusPick = async (key) => {
    if (key === activeStatus) return;
    setPendingStatus(key);
    setStatusError(null);
    const { error } = await updateStatus(key);
    if (error) {
      setPendingStatus(null);
      setStatusError(error.message || 'Could not update status.');
    }
    // On success, leave pendingStatus set until session.user_metadata catches
    // up via USER_UPDATED — see the effect below.
  };

  // Drop the optimistic override once the canonical session value matches.
  // supabase-js fires USER_UPDATED on a successful updateUser, which flows
  // through AuthContext and re-renders this page with the new user_metadata.
  useEffect(() => {
    if (!pendingStatus) return;
    if (user.user_metadata?.status === pendingStatus) {
      setPendingStatus(null);
    }
  }, [user.user_metadata?.status, pendingStatus]);

  // Ask the server whether this account has a password (auth.users can't be
  // read from the client, and identities/providers don't reflect a password
  // set on an OAuth account). Skip the round-trip if identities already prove it.
  useEffect(() => {
    if (identityHasPassword) { setServerHasPassword(true); return; }
    let alive = true;
    supabase.rpc('current_user_has_password').then(({ data, error }) => {
      if (alive && !error) setServerHasPassword(data === true);
    });
    return () => { alive = false; };
  }, [user.id, identityHasPassword]);

  // Esc closes the reset-password modal (unless a save is in flight).
  useEffect(() => {
    if (!showReset) return;
    const onKey = (e) => { if (e.key === 'Escape' && !pwBusy) setShowReset(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showReset, pwBusy]);

  const handleLinkGoogle = async () => {
    if (googleLinked || linkingGoogle) return;
    setLinkingGoogle(true);
    try {
      // Fires the OAuth flow in the user's default browser. The callback
      // returns via docvex://auth/callback → AuthContext's deep-link
      // handler runs exchangeCodeForSession → Supabase records the new
      // identity against the current session.
      await linkGoogle();
      // Don't reset linkingGoogle here — the OAuth round-trip happens in
      // the browser. The next session update (from onAuthStateChange)
      // will refresh `user.identities`, googleLinked flips true, and the
      // pill switches to its connected state. If the user cancels in the
      // browser, the pending state will stick until they reload the page;
      // acceptable for a one-time-per-account action.
    } catch (err) {
      setLinkingGoogle(false);
      notify({
        category: 'auth',
        variant: 'error',
        title: 'Could not link Google',
        // Common cause: "Manual linking is disabled" — requires enabling
        // the setting in Supabase Auth dashboard.
        body: err?.message || 'Try again in a moment.',
      });
    }
  };

  const handleSetPassword = async (e) => {
    e?.preventDefault?.();
    if (pwBusy) return;
    setPwError(null);
    const next = pwForm.next || '';
    const confirm = pwForm.confirm || '';
    // Supabase's default minimum is 6 chars, but we surface 8 to nudge
    // toward something not trivially guessable. The server still has
    // the final word on length / breach-list / strength rules.
    if (next.length < 8) {
      setPwError('Password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setPwError("Passwords don't match.");
      return;
    }
    setPwBusy(true);
    const { error } = await setPassword(next);
    setPwBusy(false);
    if (error) {
      setPwError(error.message || 'Could not set the password.');
      return;
    }
    setPwForm({ next: '', confirm: '', show: false });
    setShowReset(false);
    setServerHasPassword(true); // now definitely has a password
    notify({
      category: 'auth',
      variant: 'success',
      title: hasPassword ? 'Password updated' : 'Password set',
      body: hasPassword
        ? 'Your new password is active on all devices.'
        : 'You can now sign in with email + password in addition to Google.',
      dedupeKey: 'set-password-ok',
    });
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in some contexts; fail silently.
    }
  };

  // Open the in-card confirmation for a danger action.
  const openDz = (kind) => { setDeleteEmail(''); setDzClosing(false); setDzKind(kind); };

  // Cancel: play the exit animation, then unmount. No-op while an action runs.
  const closeDz = () => {
    if (busy) return;
    setDzClosing(true);
    window.setTimeout(() => { setDzKind(null); setDzClosing(false); setDeleteEmail(''); }, 200);
  };

  // Run the confirmed action. On delete failure the panel stays open to retry.
  const confirmDz = async () => {
    const kind = dzKind;
    if (!kind || busy) return;
    setBusy(true);
    try {
      if (kind === 'signout') {
        // Quits the whole app on Electron; on web it signs out and the
        // navigate below takes over.
        await logout();
        setDzKind(null);
        navigate('/');
      } else if (kind === 'erase') {
        await eraseData();
        setDzKind(null);
        navigate('/');
      } else if (kind === 'delete') {
        const { error } = await deleteAccount();
        if (error) {
          // Server-side failure (network down, function 500, expired token).
          // Surface it via a toast and keep the panel open so the user can
          // retry. The account row is untouched on error per the contract.
          notify({
            category: 'auth',
            variant: 'error',
            priority: 'critical',
            title: 'Could not delete account',
            body: error.message || 'The server rejected the request.',
          });
          return;
        }
        // Delete succeeded → session is invalid + signOut already ran. Bounce
        // to /auth so ProtectedRoute doesn't flash on this orphaned page.
        setDzKind(null);
        navigate('/auth', { replace: true });
      }
    } finally {
      setBusy(false);
    }
  };

  // Escape cancels the in-card confirmation (unless an action is in flight).
  useEffect(() => {
    if (!dzKind) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) {
        setDzClosing(true);
        window.setTimeout(() => { setDzKind(null); setDzClosing(false); }, 200);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dzKind, busy]);

  const closeReset = () => { if (!pwBusy) setShowReset(false); };

  // Shared password form fields — used by the inline "Set a password" card
  // (no-password accounts) and by the reset-password modal.
  const pwFormFields = (
    <>
      <label className="account-pw-field">
        <span className="account-pw-label">{hasPassword ? 'New password' : 'Password'}</span>
        <input
          type={pwForm.show ? 'text' : 'password'}
          className="account-pw-input"
          value={pwForm.next}
          onChange={(e) => setPwForm((p) => ({ ...p, next: e.target.value }))}
          autoComplete="new-password"
          minLength={8}
          placeholder="At least 8 characters"
          disabled={pwBusy}
          required
        />
      </label>
      <label className="account-pw-field">
        <span className="account-pw-label">Confirm</span>
        <input
          type={pwForm.show ? 'text' : 'password'}
          className="account-pw-input"
          value={pwForm.confirm}
          onChange={(e) => setPwForm((p) => ({ ...p, confirm: e.target.value }))}
          autoComplete="new-password"
          minLength={8}
          placeholder="Re-enter password"
          disabled={pwBusy}
          required
        />
      </label>
      <label className="account-pw-show">
        <input
          type="checkbox"
          checked={pwForm.show}
          onChange={(e) => setPwForm((p) => ({ ...p, show: e.target.checked }))}
          disabled={pwBusy}
        />
        <span>Show passwords</span>
      </label>
      {pwError && <div className="account-pw-error" role="alert">{pwError}</div>}
    </>
  );

  return (
    <div className="account-page">
      <header className="account-header">
        <div className="account-avatar-wrap">
          {avatarUrl ? (
            <img className="account-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="account-avatar account-avatar-fallback">{initials}</div>
          )}
          <StatusBadge status={activeStatus} size="lg" />
        </div>
        <div className="account-identity">
          <div className="account-name-row">
            <h1 className="account-name">{displayName}</h1>
            <span className="account-tier-badge">{PLAN.tier}</span>
          </div>
          <div className="account-provider-row">
            {/* Primary provider — same info as before, just no longer
                the only pill in the header. */}
            <span className="account-provider-badge">
              {provider === 'google' ? <GoogleGlyph /> : MailIcon}
              <span>{provider === 'google' ? 'Google' : 'Email'}</span>
            </span>
            {/* Google pill — skip it when Google is already the PRIMARY badge
                above (otherwise "Google" shows twice). Renders as a "Link
                Google" button when not linked, or a linked badge when Google is
                a secondary identity on an email-primary account. */}
            {(provider !== 'google' || !googleLinked) && (
              <Tooltip
                content={
                  googleLinked
                    ? 'Google account is linked'
                    : linkingGoogle
                    ? 'Opening Google sign-in…'
                    : 'Link this account with Google'
                }
              >
                <button
                  type="button"
                  className={`account-provider-badge account-provider-google${googleLinked ? ' is-linked' : ' is-linkable'}`}
                  onClick={handleLinkGoogle}
                  disabled={googleLinked || linkingGoogle}
                >
                  <GoogleGlyph />
                  <span>
                    {googleLinked
                      ? 'Google'
                      : linkingGoogle
                      ? 'Linking…'
                      : 'Link Google'}
                  </span>
                  {googleLinked && CheckIcon}
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </header>

      <section className="account-card">
        <h2 className="account-card-title">Account information</h2>
        <dl className="account-info-grid">
          <dt>Email</dt>
          <dd>{user.email}</dd>

          <dt>User ID</dt>
          <dd className="account-userid-row">
            <code className="account-userid">{user.id}</code>
            <Tooltip content={copied ? 'Copied' : 'Copy ID'}>
              <button
                className="account-copy-btn"
                onClick={handleCopyId}
                aria-label="Copy user ID"
              >
                {copied ? CheckIcon : CopyIcon}
              </button>
            </Tooltip>
          </dd>

          <dt>Joined</dt>
          <dd>{formatDate(user.created_at)}</dd>

          <dt>Last sign-in</dt>
          <dd>{formatDate(user.last_sign_in_at, true)}</dd>
        </dl>
      </section>

      {/* Set a password — only for accounts that don't have one yet (e.g. a
          Google-OAuth account adding email+password as a second sign-in). Users
          who already have a password change it via the Reset-password modal,
          opened from the danger zone. */}
      {pwKnown && !hasPassword && (
      <section className="account-card">
        <h2 className="account-card-title">Set a password</h2>
        <p className="account-card-subtitle">
          Add a password to {user.email} so you can sign in without Google.
        </p>
        <form className="account-pw-form" onSubmit={handleSetPassword}>
          {pwFormFields}
          <div className="account-pw-actions">
            <button
              type="submit"
              className="account-pw-submit"
              disabled={pwBusy || !pwForm.next || !pwForm.confirm}
            >
              {pwBusy ? 'Saving…' : 'Save password'}
            </button>
          </div>
        </form>
      </section>
      )}

      <section className="account-card">
        <h2 className="account-card-title">Activity status</h2>
        <p className="account-card-subtitle">
          How you appear to other members of your projects.
        </p>
        <ul className="account-status-list">
          {STATUS_OPTIONS.map((option) => {
            const isSelected = option.key === activeStatus;
            return (
              <li key={option.key}>
                <button
                  type="button"
                  className={`account-status-row${isSelected ? ' is-selected' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => handleStatusPick(option.key)}
                >
                  <span
                    className={`account-status-dot${option.key === 'offline' ? ' account-status-dot-offline' : ''}`}
                    style={{ '--status-color': option.color }}
                  />
                  <span className="account-status-text">
                    <span className="account-status-label">{option.label}</span>
                    <span className="account-status-desc">{option.description}</span>
                  </span>
                  {isSelected && (
                    <span className="account-status-check" aria-hidden="true">{CheckIcon}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {statusError && (
          <div className="account-status-error">{statusError}</div>
        )}
      </section>

      <section className="account-card">
        <div className="account-plan-header">
          <h2 className="account-card-title">Subscription</h2>
          <span className="account-plan-badge">{PLAN.tier}</span>
        </div>
        <ul className="account-plan-features">
          {PLAN.features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <Tooltip content="Coming soon">
          <button className="account-upgrade-btn" disabled>
            Upgrade plan
          </button>
        </Tooltip>
      </section>

      <DangerZone subtitle="Irreversible actions for your account. Proceed with care.">
        {/* Reset password — only for accounts that already have one. Opens a
            modal with the change-password form. */}
        {pwKnown && hasPassword && (
          <DangerRow title="Reset password" desc="Set a new password for email sign-in.">
            <button
              className="dz-btn"
              onClick={() => { setPwForm({ next: '', confirm: '', show: false }); setPwError(null); setShowReset(true); }}
            >
              Reset password
            </button>
          </DangerRow>
        )}

        <DangerRow title="Sign out" desc="End your current session on this device.">
          <button className="dz-btn" onClick={() => openDz('signout')}>Sign out</button>
        </DangerRow>

        <DangerRow title="Erase data" desc="Sign out from all devices and clear locally cached account data on this machine.">
          <button className="dz-btn" onClick={() => openDz('erase')}>Erase data</button>
        </DangerRow>

        <DangerRow title="Delete account" desc="Permanently remove your account, project memberships, and notifications. This cannot be undone.">
          <button className="dz-btn" onClick={() => openDz('delete')}>Delete account</button>
        </DangerRow>

        {/* In-card confirmation — the danger zone morphs into this when a danger
            button is clicked (rows blur behind a scrim, the panel rises in). */}
        {dzKind && (() => {
          const c = DZ_CONFIRMS[dzKind];
          const emailOk = !c.requireEmail
            || deleteEmail.trim().toLowerCase() === (user.email || '').trim().toLowerCase();
          return (
            <div
              className={`dz-confirm${dzClosing ? ' is-closing' : ''}`}
              role="alertdialog"
              aria-label={c.title}
              onMouseDown={(e) => { if (e.target === e.currentTarget) closeDz(); }}
            >
              <div className="dz-confirm-panel">
                <h3 className="modal-title">{c.title}</h3>
                <p className="modal-message">{c.message}</p>
                {c.requireEmail && (
                  <label className="dz-confirm-label">
                    Type <span className="dz-confirm-email">{user.email}</span> to confirm
                    <input
                      type="text"
                      className="dz-confirm-input"
                      value={deleteEmail}
                      onChange={(e) => setDeleteEmail(e.target.value)}
                      disabled={busy}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                    />
                  </label>
                )}
                <div className="modal-actions">
                  <button type="button" className="modal-btn modal-btn-cancel" onClick={closeDz} disabled={busy}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="modal-btn modal-btn-destructive"
                    onClick={confirmDz}
                    disabled={busy || !emailOk}
                  >
                    {busy ? c.busyLabel : c.confirmLabel}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </DangerZone>

      {/* Reset/change-password modal. */}
      {showReset && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeReset(); }}
        >
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="reset-pw-title">
            <h3 id="reset-pw-title" className="modal-title">Reset password</h3>
            <p className="modal-message">Set a new password for email sign-in.</p>
            <form className="account-pw-form" onSubmit={handleSetPassword}>
              {pwFormFields}
              <div className="modal-actions">
                <button type="button" className="modal-btn modal-btn-cancel" onClick={closeReset} disabled={pwBusy}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="modal-btn modal-btn-confirm"
                  disabled={pwBusy || !pwForm.next || !pwForm.confirm}
                >
                  {pwBusy ? 'Saving…' : 'Update password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
