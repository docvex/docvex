import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sendInvite } from '../lib/projects';
import { useNotifications } from '../context/NotificationsContext';
import { builtInLabel } from './RoleBadge';
// Reuse the modal backdrop/card/button styles from ConfirmModal so this
// dialog matches the rest of the app's modals (DeleteProjectModal does the
// same trick — see its file header for the rationale).
import './ConfirmModal.css';
import './InviteMemberModal.css';

// Match the server-side regex in supabase/functions/send-invite/index.ts so
// client-side validation rejects exactly what the Edge Function would reject.
// Intentionally permissive — we let Resend do the real deliverability check.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Built-in roles offered in the picker. Owner is intentionally absent: the
// RLS policy `admins insert non-owner members` rejects role='owner' inserts
// at the DB level. Custom roles (passed in via the `customRoles` prop) are
// appended to this list at render time as their own option group.
//
// `builtInLabel('viewer')` returns "Client" — the UI relabel lives in
// RoleBadge so this picker matches the rest of the app.
const BUILT_IN_OPTIONS = [
  { value: 'member', label: 'Member',                hint: 'Can read and contribute.' },
  { value: 'admin',  label: 'Admin',                 hint: 'Can manage members and project settings.' },
  { value: 'viewer', label: builtInLabel('viewer'),  hint: 'Read-only access. (Built-in name: Viewer.)' },
];

export default function InviteMemberModal({
  open,
  projectId,
  projectName,
  customRoles = [],
  onClose,
  onSent,
}) {
  const { notify } = useNotifications();
  const [email, setEmail] = useState('');
  // `roleKey` is either a built-in enum value ('member' | 'admin' | 'viewer')
  // or the synthetic string `custom:<uuid>` for a custom role. Storing
  // them in one slot keeps the <select> a simple controlled component;
  // we resolve to { baseRole, customRoleId } at submit time.
  const [roleKey, setRoleKey] = useState('member');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const emailRef = useRef(null);

  // All options the user can pick from. Built-ins first, then a custom-roles
  // option group if the project defines any. Memoised because customRoles
  // may be a fresh array reference each parent render.
  const allOptions = useMemo(() => {
    const customs = (customRoles || []).map((cr) => ({
      value: `custom:${cr.id}`,
      label: cr.name,
      hint: `Custom role — extends ${builtInLabel(cr.base_role)}.${cr.description ? ` ${cr.description}` : ''}`,
      isCustom: true,
      customRoleId: cr.id,
      baseRole: cr.base_role,
    }));
    return [...BUILT_IN_OPTIONS, ...customs];
  }, [customRoles]);

  // Reset on every open so a closed-and-reopened modal doesn't ship the
  // previous typed value. Focus the email field — first thing the admin
  // will do anyway.
  useEffect(() => {
    if (open) {
      setEmail('');
      setRoleKey('member');
      setError(null);
      setPending(false);
      requestAnimationFrame(() => emailRef.current?.focus());
    }
  }, [open]);

  // Esc dismisses unless a request is in flight — mirrors ConfirmModal /
  // DeleteProjectModal's convention.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !pending) onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, pending, onClose]);

  if (!open) return null;

  const trimmed = email.trim();
  const emailValid = EMAIL_REGEX.test(trimmed);

  // Backdrop click only dismisses when the click started on the backdrop —
  // same drag-tolerance pattern as ConfirmModal.handleBackdropMouseDown.
  const handleBackdropMouseDown = (e) => {
    if (pending) return;
    if (e.target === e.currentTarget) onClose?.();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (trimmed.length === 0) {
      setError('Email is required.');
      return;
    }
    if (!emailValid) {
      setError('Enter a valid email address.');
      return;
    }

    // Resolve the picked option to the (base enum role, custom_role_id?)
    // pair the Edge Function expects. For built-ins the customRoleId is
    // null; for custom roles we send their base_role so the invitation's
    // enum column stays valid even if the custom role is later deleted
    // (accept_invitation falls back to the enum role in that case).
    const opt = allOptions.find((o) => o.value === roleKey);
    const baseRole     = opt?.isCustom ? opt.baseRole    : roleKey;
    const customRoleId = opt?.isCustom ? opt.customRoleId : null;

    setPending(true);
    const { data, error: sendErr } = await sendInvite(projectId, trimmed, baseRole, customRoleId);
    setPending(false);

    if (sendErr) {
      // The Edge Function returns structured error bodies that supabase-js
      // surfaces as `error.message`. Show it verbatim — the function authors
      // already wrote user-friendly text ("Only admins can invite", etc.).
      setError(sendErr.message || 'Could not send the invitation. Try again.');
      return;
    }

    // The invitation row was created either way, but the email leg can
    // silently fail (Resend rejects an unverified sender domain, API key
    // missing, etc.). The function reports email_status / email_error so
    // the toast tells the admin the truth instead of falsely claiming
    // success. When the email didn't go out, the Pending list's
    // "Copy invite link" button is the workaround.
    const emailStatus = data?.email_status;
    if (emailStatus === 'sent') {
      notify({
        category: 'member',
        variant: 'success',
        icon: 'envelope',
        title: 'Invitation sent',
        body: `Email delivered to ${trimmed}.`,
        dedupeKey: `invite-sent-${data?.invitation_id ?? trimmed}`,
      });
    } else {
      // Map known status codes to a short human reason; fall back to the
      // raw email_error for anything unexpected (so a new Resend error
      // surfaces verbatim rather than being eaten by the mapping).
      const reasonByStatus = {
        skipped_no_key: 'RESEND_API_KEY not configured on the server.',
        rejected: 'Resend rejected the email — check the sender domain is verified.',
        failed: 'The server could not reach Resend (network or runtime error).',
      };
      const shortReason = reasonByStatus[emailStatus] || 'Unknown email error.';
      notify({
        category: 'member',
        variant: 'warning',
        icon: 'envelope-off',
        title: 'Invitation created — email not delivered',
        body: `${shortReason} You can copy the invite link from the Pending invitations list and share it manually. (${data?.email_error || ''})`.trim(),
        dedupeKey: `invite-email-failed-${data?.invitation_id ?? trimmed}`,
        duration: 12000,
      });
    }
    // Hand back a row shape compatible with listInvitations() so the parent
    // can splice it into its local state without a re-fetch round-trip. The
    // Edge Function only returns { ok, invitation_id }, so we synthesize the
    // rest from the values we already have on the client.
    onSent?.({
      id: data?.invitation_id,
      email: trimmed,
      role: baseRole,
      custom_role_id: customRoleId,
      // Mirror the DB default of `now() + interval '7 days'`. Used by the
      // Pending list to render the "Expires in N days" hint. The real value
      // will overwrite this on the next mount-time fetch.
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
    });
    onClose?.();
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        className="modal-card invite-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-modal-title"
      >
        <h3 id="invite-modal-title" className="modal-title">
          Invite to {projectName}
        </h3>
        <p className="modal-message">
          They'll get an email with a link that opens the desktop app and adds
          them to this project. Invitations expire in 7 days.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor="invite-email-input" className="invite-modal-label">
            Email
          </label>
          <input
            id="invite-email-input"
            ref={emailRef}
            type="email"
            className="invite-modal-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />

          <label htmlFor="invite-role-select" className="invite-modal-label">
            Role
          </label>
          <select
            id="invite-role-select"
            className="invite-modal-input invite-modal-select"
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value)}
            disabled={pending}
          >
            <optgroup label="Built-in">
              {BUILT_IN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </optgroup>
            {customRoles?.length > 0 && (
              <optgroup label="Custom roles">
                {customRoles.map((cr) => (
                  <option key={cr.id} value={`custom:${cr.id}`}>{cr.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <p className="invite-modal-role-hint">
            {allOptions.find((o) => o.value === roleKey)?.hint}
          </p>

          {error && (
            <div className="invite-modal-error" role="alert">{error}</div>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn-cancel"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal-btn modal-btn-confirm"
              disabled={pending || trimmed.length === 0}
            >
              {pending ? 'Sending…' : 'Send invitation'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
