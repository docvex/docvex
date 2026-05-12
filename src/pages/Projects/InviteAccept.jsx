import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useNotifications } from '../../context/NotificationsContext';
import { acceptInvite } from '../../lib/projects';
import './InviteAccept.css';

// SessionStorage key used by both this page (write on "Sign in" click) and
// AuthContext (read after SIGNED_IN to auto-resume the accept flow). Kept as
// an exported constant so the two sites can't drift.
export const PENDING_INVITE_TOKEN_KEY = 'docvex.pendingInviteToken';

// Maps the Edge Function's HTTP status codes to a friendly explanation.
// supabase-js doesn't expose the raw status reliably on functions.invoke
// errors — the function's response body includes a `status` field that
// surfaces in error.context as best-effort. We match on message text as a
// fallback so a missing status field still shows the right copy.
function classifyError(err) {
  if (!err) return { kind: 'unknown', title: 'Something went wrong.', body: err?.message };
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('expired'))          return { kind: 'expired' };
  if (msg.includes('already accepted')) return { kind: 'accepted' };
  if (msg.includes('not found'))        return { kind: 'notfound' };
  // The function returns 403 with body { error: 'invitation_email_mismatch' }
  // when the signed-in account doesn't match the invited email.
  if (msg.includes('mismatch') || msg.includes('email'))  return { kind: 'mismatch' };
  return { kind: 'unknown', body: err.message };
}

export default function InviteAccept() {
  const { token } = useParams();
  const { session, loading: authLoading, signOut } = useAuth();
  const { notify } = useNotifications();
  const navigate = useNavigate();

  const [accepting, setAccepting] = useState(false);
  const [resultErr, setResultErr] = useState(null);

  // Wait for the initial auth check before deciding which branch to render —
  // otherwise we'd flash the signed-out screen for a user who is in fact
  // signed in (Supabase hydrates the session asynchronously on cold start).
  if (authLoading) {
    return (
      <div className="invite-accept-page">
        <div className="invite-accept-card invite-accept-loading">
          Checking your session…
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="invite-accept-page">
        <div className="invite-accept-card invite-accept-error">
          <h1 className="invite-accept-title">Invitation link is incomplete.</h1>
          <p>The link you opened didn't include a token. Re-open the link from your email, or ask the admin to send a new invitation.</p>
          <Link to="/" className="invite-accept-secondary-link">Go to dashboard</Link>
        </div>
      </div>
    );
  }

  // Branch 1: signed out. Stash the token and route through /auth — AuthContext
  // picks it up on SIGNED_IN and auto-navigates back here so the user can
  // finish the accept without re-clicking the email link.
  if (!session) {
    const handleSignInClick = () => {
      try { sessionStorage.setItem(PENDING_INVITE_TOKEN_KEY, token); } catch { /* private mode */ }
      navigate('/auth');
    };
    return (
      <div className="invite-accept-page">
        <div className="invite-accept-card">
          <h1 className="invite-accept-title">You've been invited to a project.</h1>
          <p className="invite-accept-body">
            Sign in to accept the invitation. We'll bring you right back here
            once you're in — no need to click the email link again.
          </p>
          <div className="invite-accept-actions">
            <button
              type="button"
              className="invite-accept-primary-btn"
              onClick={handleSignInClick}
            >
              Sign in to accept
            </button>
          </div>
          <p className="invite-accept-hint">
            Heads up: the invitation only works for the email it was sent to.
          </p>
        </div>
      </div>
    );
  }

  // Branch 2 / 3: signed in. Either show the confirm panel or, after a
  // call to acceptInvite, the appropriate error state. Success short-circuits
  // to a navigate() so there's no need for a separate success render.
  if (resultErr) {
    const cls = classifyError(resultErr);
    const renderActions = (extra = null) => (
      <div className="invite-accept-actions">
        <Link to="/projects" className="invite-accept-secondary-link">Go to projects</Link>
        {extra}
      </div>
    );
    if (cls.kind === 'expired') {
      return (
        <div className="invite-accept-page">
          <div className="invite-accept-card invite-accept-error">
            <h1 className="invite-accept-title">This invitation expired.</h1>
            <p>Ask the admin to send a new one. Invitations are valid for 7 days.</p>
            {renderActions()}
          </div>
        </div>
      );
    }
    if (cls.kind === 'accepted') {
      return (
        <div className="invite-accept-page">
          <div className="invite-accept-card">
            <h1 className="invite-accept-title">You've already accepted this invitation.</h1>
            <p>The project is in your list — open it from there.</p>
            {renderActions()}
          </div>
        </div>
      );
    }
    if (cls.kind === 'notfound') {
      return (
        <div className="invite-accept-page">
          <div className="invite-accept-card invite-accept-error">
            <h1 className="invite-accept-title">Invitation not found.</h1>
            <p>It may have been revoked by the admin or the link is wrong. Ask the admin to resend.</p>
            {renderActions()}
          </div>
        </div>
      );
    }
    if (cls.kind === 'mismatch') {
      return (
        <div className="invite-accept-page">
          <div className="invite-accept-card invite-accept-error">
            <h1 className="invite-accept-title">Wrong account.</h1>
            <p>This invitation was sent to a different email. Sign out and sign back in with the account that received the invitation.</p>
            {renderActions(
              <button
                type="button"
                className="invite-accept-primary-btn"
                onClick={async () => {
                  // Preserve the token across the sign-out so the auto-resume
                  // can pick it up after the user signs in as someone else.
                  try { sessionStorage.setItem(PENDING_INVITE_TOKEN_KEY, token); } catch { /* private mode */ }
                  await signOut();
                  navigate('/auth');
                }}
              >
                Sign out & switch account
              </button>,
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="invite-accept-page">
        <div className="invite-accept-card invite-accept-error">
          <h1 className="invite-accept-title">Something went wrong.</h1>
          <p>{cls.body || 'The server rejected the invitation. Try again in a moment.'}</p>
          <div className="invite-accept-actions">
            <button
              type="button"
              className="invite-accept-secondary-link"
              onClick={() => setResultErr(null)}
            >
              Try again
            </button>
            <Link to="/projects" className="invite-accept-secondary-link">Go to projects</Link>
          </div>
        </div>
      </div>
    );
  }

  // Confirm panel
  const handleAccept = async () => {
    setAccepting(true);
    setResultErr(null);
    const { data, error } = await acceptInvite(token);
    setAccepting(false);
    if (error) {
      setResultErr(error);
      return;
    }
    // Title carries the project name when the Edge Function surfaced it
    // (current behavior — it reads the row right after the accept RPC).
    // Generic fallback covers older deployments and the rare case the
    // service-role read returned null.
    const projectName = data?.project_name;
    notify({
      category: 'system',
      variant: 'success',
      title: projectName ? `Joined "${projectName}"` : 'Joined project',
      body: projectName
        ? 'Welcome aboard — you now have access.'
        : 'You now have access. Welcome aboard.',
      dedupeKey: `invite-accepted-${data?.project_id ?? token}`,
    });
    navigate(`/projects/${data.project_id}`, { replace: true });
  };

  return (
    <div className="invite-accept-page">
      <div className="invite-accept-card">
        <h1 className="invite-accept-title">Accept this invitation?</h1>
        <p className="invite-accept-body">
          You're signed in as <strong>{session.user.email}</strong>. Accepting
          will add this project to your list and grant you the role the admin
          chose.
        </p>
        <div className="invite-accept-actions">
          <Link to="/" className="invite-accept-secondary-link">Not now</Link>
          <button
            type="button"
            className="invite-accept-primary-btn"
            onClick={handleAccept}
            disabled={accepting}
          >
            {accepting ? 'Joining…' : 'Join project'}
          </button>
        </div>
      </div>
    </div>
  );
}
