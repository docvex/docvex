import React, { useEffect, useMemo, useRef, useState } from 'react';
import { setMemberRole } from '../lib/customRoles';
import { useNotifications } from '../context/NotificationsContext';
import { builtInLabel } from './RoleBadge';
// Reuse InviteMemberModal's styles — same role-picker shape (label, select,
// hint paragraph, inline error) so the two flows feel consistent.
import './ConfirmModal.css';
import './InviteMemberModal.css';

// Built-in role options offered in the picker. Owner is excluded — the RLS
// `admins update non-owner members` policy has `with check (role <> 'owner')`,
// so promotion to owner needs a different transfer-of-ownership flow we'll
// add when that requirement lands.
const BUILT_IN_OPTIONS = [
  { value: 'member', label: 'Member',                hint: 'Can read and contribute.' },
  { value: 'admin',  label: 'Admin',                 hint: 'Can manage members and project settings.' },
  { value: 'viewer', label: builtInLabel('viewer'),  hint: 'Read-only access. (Built-in name: Viewer.)' },
];

// Build the picker option key for a member's currently-assigned role. Custom
// role wins (`custom:<uuid>`); otherwise the enum tier value. Returns
// 'member' as a safe default if the row is somehow missing — the select has
// to start somewhere.
function initialRoleKey(member) {
  if (!member) return 'member';
  if (member.custom_role_id) return `custom:${member.custom_role_id}`;
  return member.role || 'member';
}

// Modal for switching a member between roles (built-in or custom). Mirrors
// InviteMemberModal's role picker, but operates on an existing member row.
//
// Props:
//   open         — boolean; mount when true
//   member       — the project_members row being edited (with profile join).
//                  Provides the current role/custom_role_id used to seed the
//                  picker, and the user_id / display name for the RPC + copy.
//   projectId    — the project being edited, threaded through to setMemberRole.
//   customRoles  — full custom-role catalog for the project (from useProject()).
//   memberName   — pre-resolved display name for the title (caller already
//                  computes this for the row).
//   onClose      — fired on Esc, backdrop click, or Cancel. Not fired while a
//                  request is in flight (mirrors the rest of the modals).
//   onSaved      — optional success callback. Receives the new option chosen
//                  ({ baseRole, customRoleId }) so the parent can toast / etc.
export default function ChangeMemberRoleModal({
  open,
  member,
  projectId,
  customRoles = [],
  memberName,
  onClose,
  onSaved,
}) {
  const { notify } = useNotifications();
  const [roleKey, setRoleKey] = useState('member');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const selectRef = useRef(null);

  // Same option-list shape InviteMemberModal builds — built-ins first, then
  // a custom-role group if the project defines any.
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

  // Reset on every open so a closed-and-reopened modal seeds the picker from
  // the latest server state, not the previous selection. Focus the select so
  // arrow keys work immediately.
  useEffect(() => {
    if (open) {
      setRoleKey(initialRoleKey(member));
      setError(null);
      setPending(false);
      requestAnimationFrame(() => selectRef.current?.focus());
    }
  }, [open, member]);

  // Esc dismisses unless a request is in flight.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !pending) onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, pending, onClose]);

  if (!open || !member) return null;

  // Backdrop click only dismisses when the click started on the backdrop —
  // same drag-tolerance pattern as ConfirmModal / InviteMemberModal.
  const handleBackdropMouseDown = (e) => {
    if (pending) return;
    if (e.target === e.currentTarget) onClose?.();
  };

  const currentKey = initialRoleKey(member);
  const dirty = roleKey !== currentKey;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!dirty || pending) return;
    setError(null);

    const opt = allOptions.find((o) => o.value === roleKey);
    const baseRole     = opt?.isCustom ? opt.baseRole     : roleKey;
    const customRoleId = opt?.isCustom ? opt.customRoleId : null;

    setPending(true);
    const { error: rpcErr } = await setMemberRole({
      projectId,
      userId: member.user_id,
      baseRole,
      customRoleId,
    });
    setPending(false);

    if (rpcErr) {
      // Typical failure: actor's capability got revoked between page load and
      // click, RLS rejects with zero rows / permission denied. Leave the
      // modal open with an inline message so the user can read it.
      setError(rpcErr.message || 'Could not update the member’s role.');
      return;
    }

    notify({
      category: 'member',
      variant: 'success',
      icon: 'edit',
      title: 'Role updated',
      body: `${memberName || 'Member'} is now ${opt?.label || baseRole}.`,
      dedupeKey: `member-role-changed:${projectId}:${member.user_id}`,
    });
    onSaved?.({ baseRole, customRoleId });
    onClose?.();
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        className="modal-card invite-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-role-modal-title"
      >
        <h3 id="change-role-modal-title" className="modal-title">
          Change role
        </h3>
        <p className="modal-message">
          Pick a new role for <strong>{memberName || 'this member'}</strong>.
          Their access updates instantly.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor="change-role-select" className="invite-modal-label">
            Role
          </label>
          <select
            id="change-role-select"
            ref={selectRef}
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
              disabled={pending || !dirty}
            >
              {pending ? 'Saving…' : 'Save role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
