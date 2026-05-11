import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { PLAN } from '../lib/plan';
import ConfirmModal from '../components/ConfirmModal';
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

export default function Account() {
  const { session, signOut, eraseData } = useAuth();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'signout' | 'erase' | null
  const [busy, setBusy] = useState(false);

  // ProtectedRoute should prevent us getting here without a session,
  // but guard anyway in case StrictMode renders during the redirect.
  if (!session) return null;

  const user = session.user;
  const provider = user.app_metadata?.provider || 'email';
  const avatarUrl = user.user_metadata?.avatar_url;
  const displayName =
    user.user_metadata?.full_name ||
    user.user_metadata?.name ||
    user.email;
  const initials = (user.email || '?').charAt(0).toUpperCase();

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

  return (
    <div className="account-page">
      <header className="account-header">
        {avatarUrl ? (
          <img className="account-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="account-avatar account-avatar-fallback">{initials}</div>
        )}
        <div className="account-identity">
          <h1 className="account-name">{displayName}</h1>
          <span className="account-provider-badge">
            {provider === 'google' ? 'Google' : 'Email'}
          </span>
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

      <section className="account-card account-danger">
        <h2 className="account-card-title">Danger zone</h2>

        <div className="account-danger-row">
          <div className="account-danger-text">
            <h3 className="account-danger-label">Sign out</h3>
            <p className="account-danger-desc">End your current session on this device.</p>
          </div>
          <button
            className="account-danger-btn"
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
    </div>
  );
}
