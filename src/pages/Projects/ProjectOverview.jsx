import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { deleteProject, listInvitations, revokeInvite, sendInvite } from '../../lib/projects';
import DeleteProjectModal from '../../components/DeleteProjectModal';
import InviteMemberModal from '../../components/InviteMemberModal';
import './ProjectDashboard.css';

// Chevron-left icon for the "< Back" link — inline SVG so we don't pull in an
// icon library, consistent with the sidebar icon convention (currentColor
// stroke so it inherits the link's hover state).
const ChevronLeftIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

// Project Overview — the landing page for /projects/:id. Reached by clicking
// a card in the Projects list. Focus: "who's on this project" + "manage it".
// The "working surface" (recent files) lives at /projects/:id/dashboard so
// users can keep two distinct mental models for the two destinations.
//
// Auto-selecting this project into SelectedProjectContext is handled by
// <ProjectAutoSelect/> at the ProjectShell level — see App.jsx.

// Resolves a human-readable display name from a member profile in the same
// order as the Sidebar/Account helpers (full_name > name > email local part).
function getMemberName(profile) {
  if (!profile) return 'Unknown member';
  if (profile.full_name) return profile.full_name;
  if (profile.name) return profile.name;
  if (profile.email) {
    const at = profile.email.indexOf('@');
    return at > 0 ? profile.email.slice(0, at) : profile.email;
  }
  return 'Unknown member';
}

function MemberAvatar({ profile }) {
  const avatarUrl = profile?.avatar_url;
  const initial = (profile?.email || profile?.full_name || '?').charAt(0).toUpperCase();
  if (avatarUrl) {
    return <img className="member-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />;
  }
  return <span className="member-avatar member-avatar-fallback">{initial}</span>;
}

// "Expires in N days" hint for a pending invitation. Rounds down on the day
// — a row that expires in 23h59m reads as "Expires today", a row that
// expires in 1d05m reads as "Expires in 1 day". Past dates render "Expired".
function formatExpiry(isoString) {
  if (!isoString) return '';
  const expires = new Date(isoString).getTime();
  const now = Date.now();
  const ms = expires - now;
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'Expired';
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  return 'Expires soon';
}

export default function ProjectOverview() {
  const { project, role, members, loading, error } = useProject();
  const { clearSelection } = useSelectedProject();
  const { notify } = useNotifications();
  const navigate = useNavigate();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Admin-only — owner+admin both qualify per the RANK helper in RoleGate.
  // Inline comparison avoids the extra hook call since we only need it once.
  const isAdmin = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  // Pending invitations state. Only fetched + rendered for admins (RLS would
  // return an empty list to non-admins anyway, but the fetch is wasted work
  // and rendering an empty Pending card on non-admin views would be misleading).
  const [invitations, setInvitations] = useState([]);
  const [invLoaded, setInvLoaded] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [resendingId, setResendingId] = useState(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  // Tracks which invitation row most recently had its link copied, so the
  // per-row button can briefly flip its label to "Copied" without holding
  // shared "I copied SOMETHING" state across all rows.
  const [copiedInviteId, setCopiedInviteId] = useState(null);

  useEffect(() => {
    if (!project?.id || !isAdmin) {
      setInvitations([]);
      setInvLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error: invErr } = await listInvitations(project.id);
      if (cancelled) return;
      // listInvitations returns { data: [], error } on failure — render an
      // empty list rather than blocking the page. Admin-targeting failures
      // are rare and the page still functions without the pending section.
      setInvitations(invErr ? [] : (data || []));
      setInvLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [project?.id, isAdmin]);

  const handleInviteSent = (newInvitation) => {
    // Prepend so the freshest invite reads first (matches the API's order-by
    // created_at desc). De-dup by email + id so a re-invite of the same
    // address (which the Edge Function upserts) doesn't create a phantom row.
    setInvitations((prev) => {
      const sameAddr = prev.findIndex((i) =>
        i.email?.toLowerCase() === newInvitation.email?.toLowerCase());
      if (sameAddr >= 0) {
        const next = prev.slice();
        next[sameAddr] = { ...prev[sameAddr], ...newInvitation };
        return next;
      }
      return [newInvitation, ...prev];
    });
  };

  // Copy the docvex://invite?token=... URL to the clipboard so the admin
  // can DM it manually when the auto-send email leg failed (Resend
  // domain not verified, no API key, etc.). The token is already in the
  // local state from listInvitations(); admins can see it because the RLS
  // policy on project_invitations gates SELECT on has_project_role('admin').
  const handleCopyLink = async (inv) => {
    if (!inv?.token) return;
    const url = `docvex://invite?token=${inv.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedInviteId(inv.id);
      // Auto-reset so a row that was once copied doesn't stay highlighted
      // forever across re-renders.
      setTimeout(() => {
        setCopiedInviteId((cur) => (cur === inv.id ? null : cur));
      }, 1800);
    } catch {
      notify({
        category: 'system',
        variant: 'error',
        title: 'Could not copy',
        body: 'Clipboard access was denied.',
      });
    }
  };

  // Retrigger the email send for an EXISTING pending invitation. The
  // send-invite Edge Function's upsert path takes the existing row's
  // token (no new invitation created), runs the same Resend call as a
  // fresh invite, and returns email_status + email_error so we can toast
  // the result. Useful for "the email went to spam" / "Resend was misconfigured
  // and I just fixed it" / "Gmail dropped it on the floor" cases.
  const handleResend = async (inv) => {
    if (!inv?.email || !inv?.role) return;
    setResendingId(inv.id);
    const { data, error } = await sendInvite(project.id, inv.email, inv.role);
    setResendingId(null);
    if (error) {
      notify({
        category: 'system',
        variant: 'error',
        title: 'Could not resend invitation',
        body: error.message || 'The server rejected the request.',
      });
      return;
    }
    const emailStatus = data?.email_status;
    if (emailStatus === 'sent') {
      notify({
        category: 'system',
        variant: 'success',
        title: 'Invitation resent',
        body: `Email delivered to ${inv.email}.`,
        dedupeKey: `invite-resent-${inv.id}`,
      });
    } else {
      const reasonByStatus = {
        skipped_no_key: 'RESEND_API_KEY not configured on the server.',
        rejected: 'Resend rejected the email — check the sender domain is verified.',
        failed: 'The server could not reach Resend (network or runtime error).',
      };
      const shortReason = reasonByStatus[emailStatus] || 'Unknown email error.';
      notify({
        category: 'system',
        variant: 'warning',
        title: 'Email not delivered',
        body: `${shortReason} (${data?.email_error || ''})`.trim(),
        dedupeKey: `invite-resend-failed-${inv.id}`,
        duration: 12000,
      });
    }
  };

  const handleRevoke = async (invitationId) => {
    setRevokingId(invitationId);
    const { error: revErr } = await revokeInvite(invitationId);
    setRevokingId(null);
    if (revErr) {
      notify({
        category: 'system',
        variant: 'error',
        title: 'Could not revoke invitation',
        body: revErr.message || 'The server rejected the request.',
      });
      return;
    }
    setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
    notify({
      category: 'system',
      variant: 'success',
      title: 'Invitation revoked',
      dedupeKey: `invite-revoked-${invitationId}`,
    });
  };

  if (loading) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-loading">Loading project…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-error">
          {error.message}
          <Link to="/projects" className="project-dashboard-back-link">Back to projects</Link>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="project-dashboard">
        <div className="project-dashboard-error">
          Project not found.
          <Link to="/projects" className="project-dashboard-back-link">Back to projects</Link>
        </div>
      </div>
    );
  }

  const handleConfirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    const { error: delErr } = await deleteProject(project.id);
    if (delErr) {
      // Typical failure: role was demoted out of 'owner' between load and
      // click and RLS now rejects. Leave the modal open so the owner can see
      // the reason and either retry or close.
      setDeleteError(delErr.message || 'Failed to delete project.');
      setDeleting(false);
      return;
    }
    // Drop the stale selection so the sidebar's picker doesn't keep naming a
    // deleted project for a frame after navigation.
    clearSelection();
    navigate('/projects', { replace: true });
  };

  return (
    <div className="project-dashboard">
      <header className="project-dashboard-header">
        <Link to="/projects" className="project-dashboard-back">
          {ChevronLeftIcon}
          <span>Back</span>
        </Link>
        <div className="project-dashboard-title-row">
          <h1 className="project-dashboard-title">{project.name}</h1>
          <span className={`project-dashboard-role role-${role}`}>{role}</span>
        </div>
        {project.description && (
          <p className="project-dashboard-description">{project.description}</p>
        )}
      </header>

      <section className="project-dashboard-card">
        <div className="project-dashboard-card-header">
          <h2 className="project-dashboard-card-title">Members</h2>
          <div className="project-dashboard-card-actions">
            <span className="project-dashboard-card-count">
              {members.length} {members.length === 1 ? 'person' : 'people'}
            </span>
            {isAdmin && (
              <button
                type="button"
                className="project-dashboard-card-btn"
                onClick={() => setInviteOpen(true)}
              >
                + Invite member
              </button>
            )}
          </div>
        </div>
        <p className="project-dashboard-card-subtitle">
          Everyone with access to this project.
        </p>

        {members.length === 0 ? (
          <div className="project-dashboard-empty">No members yet.</div>
        ) : (
          <ul className="member-list">
            {members.map((m) => (
              <li key={m.user_id} className="member-row">
                <MemberAvatar profile={m.profile} />
                <div className="member-text">
                  <div className="member-name">{getMemberName(m.profile)}</div>
                  {m.profile?.email && (
                    <div className="member-email">{m.profile.email}</div>
                  )}
                </div>
                <span className={`project-dashboard-role role-${m.role}`}>{m.role}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Pending invitations — admin-only AND hidden when there are none, so
          the page stays uncluttered for projects without active invites.
          Auto-populated on send (handleInviteSent) and auto-removed on revoke
          via the local state patches; no manual refresh required. */}
      {isAdmin && invLoaded && invitations.length > 0 && (
        <section className="project-dashboard-card">
          <div className="project-dashboard-card-header">
            <h2 className="project-dashboard-card-title">Pending invitations</h2>
            <span className="project-dashboard-card-count">
              {invitations.length} pending
            </span>
          </div>
          <p className="project-dashboard-card-subtitle">
            Waiting on the invitee to click the link in their email.
          </p>
          <ul className="invitation-list">
            {invitations.map((inv) => (
              <li key={inv.id || inv.email} className="invitation-row">
                <div className="invitation-text">
                  <div className="invitation-email">{inv.email}</div>
                  <div className="invitation-meta">
                    {formatExpiry(inv.expires_at)}
                  </div>
                </div>
                <span className={`project-dashboard-role role-${inv.role}`}>{inv.role}</span>
                <button
                  type="button"
                  className="invitation-copy-btn"
                  onClick={() => handleCopyLink(inv)}
                  title="Copy docvex:// invite link (useful when the email didn't deliver)"
                >
                  {copiedInviteId === inv.id ? 'Copied!' : 'Copy link'}
                </button>
                <button
                  type="button"
                  className="invitation-copy-btn"
                  onClick={() => handleResend(inv)}
                  disabled={resendingId === inv.id}
                  title="Resend the invitation email (re-uses the same token, no new row)"
                >
                  {resendingId === inv.id ? 'Resending…' : 'Resend email'}
                </button>
                <button
                  type="button"
                  className="invitation-revoke-btn"
                  onClick={() => handleRevoke(inv.id)}
                  disabled={revokingId === inv.id}
                  title="Revoke this invitation"
                >
                  {revokingId === inv.id ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isOwner && (
        <section className="project-dashboard-danger">
          <h2>Danger zone</h2>
          <div className="project-dashboard-danger-row">
            <div className="project-dashboard-danger-text">
              <p className="project-dashboard-danger-title">Delete this project</p>
              <p className="project-dashboard-danger-desc">
                Once deleted, you can't recover it. All members, pending
                invites, and uploaded files will be removed.
              </p>
            </div>
            <button
              type="button"
              className="project-dashboard-danger-btn"
              onClick={() => { setDeleteError(null); setDeleteOpen(true); }}
              disabled={deleting}
            >
              Delete project
            </button>
          </div>
          {deleteError && (
            <div className="project-dashboard-danger-error" role="alert">
              {deleteError}
            </div>
          )}
        </section>
      )}

      <DeleteProjectModal
        open={deleteOpen}
        projectName={project.name}
        pending={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => { if (!deleting) setDeleteOpen(false); }}
      />

      <InviteMemberModal
        open={inviteOpen}
        projectId={project.id}
        projectName={project.name}
        onClose={() => setInviteOpen(false)}
        onSent={handleInviteSent}
      />
    </div>
  );
}
