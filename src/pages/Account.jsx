import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationsContext';
import { PLAN } from '../lib/plan';
import ConfirmModal from '../components/ConfirmModal';
import DeleteAccountModal from '../components/DeleteAccountModal';
import ThemePicker from '../components/ThemePicker';
import StatusBadge from '../components/StatusBadge';
import { STATUS_OPTIONS, DEFAULT_STATUS_KEY, updateStatus } from '../lib/userStatus';
import './Account.css';

function titleCase(s = '') {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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

export default function Account() {
  const { session, signOut, eraseData, deleteAccount, linkGoogle } = useAuth();
  const { notify } = useNotifications();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'signout' | 'erase' | null
  const [busy, setBusy] = useState(false);
  // Separate state for the delete-account modal because (a) it has a
  // distinct shape (type-to-confirm input, not just yes/no) and (b) it
  // lives in its own modal component, not the shared ConfirmModal.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [linkingGoogle, setLinkingGoogle] = useState(false);
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
  const linkedProviders = new Set(
    (user.identities || []).map((i) => i.provider),
  );
  const googleLinked = linkedProviders.has('google');
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

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in some contexts; fail silently.
    }
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      if (confirm === 'signout') {
        await signOut();
      } else if (confirm === 'erase') {
        await eraseData();
      }
      setConfirm(null);
      navigate('/');
    } finally {
      setBusy(false);
    }
  };

  const cancelConfirm = () => {
    if (busy) return;
    setConfirm(null);
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    const { error } = await deleteAccount();
    setDeleting(false);
    if (error) {
      // Server-side failure (network down, function 500, expired token).
      // Surface it via a toast and leave the modal open so the user can
      // see what went wrong and retry. The account row is untouched on
      // error per the function's contract.
      notify({
        category: 'auth',
        variant: 'error',
        priority: 'critical',
        title: 'Could not delete account',
        body: error.message || 'The server rejected the request.',
      });
      return;
    }
    // Delete succeeded → the session is invalid + signOut has already run.
    // Close the modal and bounce to /auth so ProtectedRoute doesn't flash
    // the spinner on this now-orphaned page.
    setDeleteOpen(false);
    navigate('/auth', { replace: true });
  };

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
          <h1 className="account-name">{displayName}</h1>
          <div className="account-provider-row">
            {/* Primary provider — same info as before, just no longer
                the only pill in the header. */}
            <span className="account-provider-badge">
              {provider === 'google' ? 'Google' : 'Email'}
            </span>
            {/* Google pill always renders. When already linked it's a
                static badge with a checkmark; when not, it becomes a
                button that kicks off the OAuth link flow. */}
            <button
              type="button"
              className={`account-provider-badge account-provider-google${googleLinked ? ' is-linked' : ' is-linkable'}`}
              onClick={handleLinkGoogle}
              disabled={googleLinked || linkingGoogle}
              title={
                googleLinked
                  ? 'Google account is linked'
                  : linkingGoogle
                  ? 'Opening Google sign-in…'
                  : 'Link this account with Google'
              }
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
            <button
              className="account-copy-btn"
              onClick={handleCopyId}
              title={copied ? 'Copied' : 'Copy ID'}
              aria-label="Copy user ID"
            >
              {copied ? CheckIcon : CopyIcon}
            </button>
          </dd>

          <dt>Provider</dt>
          <dd>{titleCase(provider)}</dd>

          <dt>Joined</dt>
          <dd>{formatDate(user.created_at)}</dd>

          <dt>Last sign-in</dt>
          <dd>{formatDate(user.last_sign_in_at, true)}</dd>
        </dl>
      </section>

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
        <button className="account-upgrade-btn" disabled title="Coming soon">
          Upgrade plan
        </button>
      </section>

      {/* Theme picker — sits between Subscription and Danger zone per the
          plan. Lets the user toggle between Cream (light brand default) and
          Ink (dark variant of the same brand palette). Stores per-user in
          localStorage; see src/context/ThemeContext.jsx. */}
      <ThemePicker />

      <section className="account-card account-danger">
        <h2 className="account-card-title">Danger zone</h2>

        <div className="account-danger-row">
          <div className="account-danger-text">
            <h3 className="account-danger-label">Sign out</h3>
            <p className="account-danger-desc">End your current session on this device.</p>
          </div>
          <button
            className="account-danger-btn destructive"
            onClick={() => setConfirm('signout')}
          >
            Sign out
          </button>
        </div>

        <div className="account-danger-row">
          <div className="account-danger-text">
            <h3 className="account-danger-label">Erase data</h3>
            <p className="account-danger-desc">
              Sign out from all devices and clear locally cached account data on this machine.
            </p>
          </div>
          <button
            className="account-danger-btn destructive"
            onClick={() => setConfirm('erase')}
          >
            Erase data
          </button>
        </div>

        <div className="account-danger-row">
          <div className="account-danger-text">
            <h3 className="account-danger-label">Delete account</h3>
            <p className="account-danger-desc">
              Permanently remove your account, project memberships, and notifications.
              This cannot be undone.
            </p>
          </div>
          <button
            className="account-danger-btn destructive"
            onClick={() => setDeleteOpen(true)}
            disabled={deleting}
          >
            Delete account
          </button>
        </div>
      </section>

      <ConfirmModal
        open={confirm === 'signout'}
        title="Sign out?"
        message="You'll need to sign in again to access your account."
        confirmLabel={busy ? 'Signing out…' : 'Sign out'}
        cancelLabel="Cancel"
        destructive
        onConfirm={handleConfirm}
        onCancel={cancelConfirm}
      />

      <ConfirmModal
        open={confirm === 'erase'}
        title="Erase all account data?"
        message="This signs you out from every device and removes locally cached account data. You can sign back in afterwards, but anything stored only on this machine will be gone."
        confirmLabel={busy ? 'Erasing…' : 'Erase everything'}
        cancelLabel="Cancel"
        destructive
        onConfirm={handleConfirm}
        onCancel={cancelConfirm}
      />

      <DeleteAccountModal
        open={deleteOpen}
        email={user.email}
        pending={deleting}
        onConfirm={handleDeleteAccount}
        onCancel={() => { if (!deleting) setDeleteOpen(false); }}
      />
    </div>
  );
}
