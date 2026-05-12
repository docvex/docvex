import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProject } from '../../context/ProjectContext';
import { useSelectedProject } from '../../context/SelectedProjectContext';
import { useNotifications } from '../../context/NotificationsContext';
import { useAuth } from '../../context/AuthContext';
import { deleteProject, listInvitations, revokeInvite, sendInvite, updateProject } from '../../lib/projects';
import DeleteProjectModal from '../../components/DeleteProjectModal';
import InviteMemberModal from '../../components/InviteMemberModal';
import RoleLocked from '../../components/RoleLocked';
import './ProjectDashboard.css';

// Chevron-left icon for the "< Back" link — inline SVG so we don't pull in an
// icon library, consistent with the sidebar icon convention (currentColor
// stroke so it inherits the link's hover state).
const ChevronLeftIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

// Matches the UsersIcon used on Project cards in ProjectList.jsx so the
// "N members" affordance reads consistently across the two surfaces.
const UsersIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
  const { session } = useAuth();
  const navigate = useNavigate();

  // The caller's auth id, used to flag their row in the Members list with a
  // "You" pill. Read off the session because useProject() returns members
  // joined with profile data only — no flag for self.
  const currentUserId = session?.user?.id ?? null;

  // Stable "you first, then everyone else in their existing order" ordering.
  // useMemo so we don't re-allocate the array on every unrelated re-render
  // (notifications, etc.) — members itself is referentially stable across
  // those because ProjectContext only swaps it when the Realtime channel
  // fires.
  const orderedMembers = useMemo(() => {
    if (!currentUserId) return members;
    const selfIdx = members.findIndex((m) => m.user_id === currentUserId);
    if (selfIdx <= 0) return members;
    return [members[selfIdx], ...members.slice(0, selfIdx), ...members.slice(selfIdx + 1)];
  }, [members, currentUserId]);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  // Admin-only — owner+admin both qualify per the RANK helper in RoleGate.
  // Inline comparison avoids the extra hook call since we only need it once.
  const isAdmin = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  // Top-level tab. Local state is fine: the value isn't deep-linkable (no
  // need to share "I was on Members" via URL — both tabs live at the same
  // route) and resetting to "project" on remount is the right default for
  // someone arriving on the page fresh.
  //
  // Every role sees every tab now: the role-gating contract is "render the
  // feature for everyone, lay a RoleLocked overlay over it for non-matching
  // viewers." So no auto-switch on role — even a viewer can browse to the
  // Project tab and see the locked details/danger zone.
  const [activeTab, setActiveTab] = useState('project');

  // ── Project (name + description) edit form ──────────────────────────────
  // Local form state mirrors the server's project row, synced from useProject()
  // via the effect below. We keep it separate from project.{name,description}
  // so the user can type freely without optimistically writing into the
  // shared context — only Save commits.
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingProject, setSavingProject] = useState(false);
  const [projectFormError, setProjectFormError] = useState(null);

  // Sync the form from the server whenever the project row changes (initial
  // load + any Realtime UPDATE from ProjectContext's postgres_changes
  // subscription). This means a rename committed elsewhere — another admin,
  // another window — appears in the form immediately rather than the user
  // staring at stale text.
  useEffect(() => {
    setEditName(project?.name ?? '');
    setEditDescription(project?.description ?? '');
    setProjectFormError(null);
  }, [project?.id, project?.name, project?.description]);

  const projectFormDirty =
    (editName.trim() !== (project?.name ?? '')) ||
    ((editDescription.trim() || null) !== (project?.description ?? null));

  const handleSaveProject = async (e) => {
    e.preventDefault();
    setProjectFormError(null);
    const trimmedName = editName.trim();
    if (trimmedName.length === 0) {
      setProjectFormError('Name is required.');
      return;
    }
    if (trimmedName.length > 80) {
      setProjectFormError('Name is too long (max 80 characters).');
      return;
    }
    setSavingProject(true);
    const { error: updErr } = await updateProject(project.id, {
      name: trimmedName,
      description: editDescription,
    });
    setSavingProject(false);
    if (updErr) {
      setProjectFormError(updErr.message || 'Could not save the project.');
      return;
    }
    // Don't manually patch project state here — ProjectContext's Realtime
    // subscription fires the UPDATE event and the sync effect above resets
    // the form to the new server values. (If Realtime is dropped for any
    // reason, the next refresh() call brings everything in line.)
    notify({
      category: 'system',
      variant: 'success',
      title: 'Project updated',
      dedupeKey: `project-updated-${project.id}`,
    });
  };

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

  // Tab definitions are an array so the bar renders via .map() and adding
  // a third tab later (Files, Activity) is a one-line change. Count badge on
  // Members is the same data the Members card header used to surface.
  //
  // Every tab is visible to every role; role-gated content inside a tab is
  // wrapped in RoleLocked so it's previewable-but-uninteractive for users
  // who don't meet the role requirement.
  const tabs = [
    { id: 'project', label: 'Project' },
    { id: 'members', label: 'Members', count: members.length },
    { id: 'ai', label: 'AI' },
  ];

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
      </header>

      {/* Tab bar — visual nav between the two panels. role="tablist" so
          screen readers announce the relationship; each button is a tab
          whose pressed state mirrors activeTab. */}
      <div className="project-tabs" role="tablist" aria-label="Project sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`project-tab ${activeTab === t.id ? 'is-active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span>{t.label}</span>
            {typeof t.count === 'number' && (
              <span className="project-tab-count">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Project tab — both children are owner-only features, so each is
          wrapped in a RoleLocked overlay for non-owners. Wrapping the
          individual cards (rather than the whole tab) keeps the radius +
          backdrop fitted to each card's edge instead of one giant overlay
          covering both. */}
      {activeTab === 'project' && (
        <>
          <RoleLocked locked={!isOwner} requiredRole="owner">
            <section className="project-dashboard-card">
              <div className="project-dashboard-card-header">
                <h2 className="project-dashboard-card-title">Project details</h2>
              </div>
              <p className="project-dashboard-card-subtitle">
                Change the project name and description. Visible to every member.
              </p>

              <form className="project-edit-form" onSubmit={handleSaveProject} noValidate>
                <label className="project-edit-field">
                  <span className="project-edit-label">
                    Name <span className="project-edit-required">*</span>
                  </span>
                  <input
                    type="text"
                    className="project-edit-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={80}
                    disabled={savingProject}
                    required
                  />
                </label>

                <label className="project-edit-field">
                  <span className="project-edit-label">Description</span>
                  <textarea
                    className="project-edit-textarea"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="What is this project about? (optional)"
                    rows={4}
                    maxLength={500}
                    disabled={savingProject}
                  />
                </label>

                {projectFormError && (
                  <div className="project-edit-error">{projectFormError}</div>
                )}

                <div className="project-edit-actions">
                  <button
                    type="button"
                    className="project-edit-cancel"
                    onClick={() => {
                      // Snap the form back to the server's current values so
                      // the user can abandon edits without reloading.
                      setEditName(project.name ?? '');
                      setEditDescription(project.description ?? '');
                      setProjectFormError(null);
                    }}
                    disabled={savingProject || !projectFormDirty}
                  >
                    Discard
                  </button>
                  <button
                    type="submit"
                    className="project-edit-submit"
                    disabled={savingProject || !projectFormDirty || editName.trim().length === 0}
                  >
                    {savingProject ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            </section>
          </RoleLocked>

          <RoleLocked locked={!isOwner} requiredRole="owner">
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
          </RoleLocked>
        </>
      )}

      {activeTab === 'members' && (
        <>
          <section className="project-dashboard-card">
            <div className="project-dashboard-card-header">
              <h2 className="project-dashboard-card-title">Members</h2>
              <div className="project-dashboard-card-actions">
                <span className="project-dashboard-card-count">
                  {UsersIcon}
                  {members.length} {members.length === 1 ? 'member' : 'members'}
                </span>
                {/* Invite-member button is admin-only and opted out of the
                    overlay pattern (per user direction): non-admins don't
                    see the button at all. A blurred button in the card
                    header looked off-balance against the count badge, and
                    the invite affordance is already discoverable from the
                    Members card itself. */}
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
                {orderedMembers.map((m) => {
                  const isSelf = m.user_id === currentUserId;
                  return (
                    <li key={m.user_id} className="member-row">
                      <MemberAvatar profile={m.profile} />
                      <div className="member-text">
                        <div className="member-name">{getMemberName(m.profile)}</div>
                        {m.profile?.email && (
                          <div className="member-email">{m.profile.email}</div>
                        )}
                      </div>
                      {isSelf && <span className="member-self-pill">Me</span>}
                      <span className={`project-dashboard-role role-${m.role}`}>{m.role}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Pending invitations — admin-only, AND opted out of the overlay
              pattern per explicit user direction: non-admins don't see the
              card at all. (Rationale: pending invitee emails are sensitive
              enough that even a placeholder card with a blur on top reads
              as "info leak adjacent." Hiding entirely is unambiguous.)
              Also hidden for admins when there's nothing pending, to keep
              the page uncluttered. */}
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
        </>
      )}

      {activeTab === 'ai' && (
        <section className="project-dashboard-card">
          <div className="project-dashboard-card-header">
            <h2 className="project-dashboard-card-title">AI</h2>
          </div>
          {/* Placeholder copy — real AI surface (summaries, draft suggestions,
              project Q&A, …) lands when the AI backend is wired up. Keeping
              the tab live now so the IA reads "here's where AI will live"
              instead of users guessing whether the feature exists at all. */}
          <p className="project-dashboard-card-subtitle">
            Here will be displayed all AI-related data for this project.
          </p>
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
