import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CAPABILITIES, createCustomRole, updateCustomRole, resolveCapability } from '../lib/customRoles';
import { builtInLabel } from './RoleBadge';
import './ConfirmModal.css';
import './InviteMemberModal.css';
import './CustomRoleEditor.css';

// Create / edit modal for a single custom role. Single component handles
// both modes — if `role` is null we're creating, otherwise editing the
// passed-in role. Wholesale-replace semantics: the editor sends the desired
// final state on Save, the RPC handles the diff (delete-all + insert-all
// inside one transaction).
//
// Capability tri-state: each row resolves to "Granted" / "Not granted"
// based on the base tier's default. The user can toggle the row to apply
// an override (granted=opposite of default) or clear the override (revert
// to inheriting the default). The "Effective" column always reflects the
// resolved state so there's no guesswork.
//
// Props:
//   open        — boolean; mount the dialog when true
//   role        — existing role to edit, or null/undefined to create
//   projectId   — required for create; ignored on edit (role.project_id wins)
//   onClose     — called on Esc / backdrop / Cancel button
//   onSaved     — called with the new/updated role's id after a successful
//                 RPC; the parent uses this to refresh state. (Realtime
//                 also fires, but the callback gives instant feedback.)
export default function CustomRoleEditor({ open, role, projectId, onClose, onSaved }) {
  const isEdit = !!role;
  const nameRef = useRef(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [baseRole, setBaseRole] = useState('member');
  // overrides is a Map<capability, boolean> — present means an explicit
  // override (granted=true/false). Absent means "inherit from base tier".
  const [overrides, setOverrides] = useState(() => new Map());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  // Hydrate / reset on open + when the role prop changes. We rebuild the
  // override Map from the role's capabilities array so the editor's local
  // state diverges from the prop only while the user is making changes.
  useEffect(() => {
    if (!open) return;
    if (isEdit) {
      setName(role.name ?? '');
      setDescription(role.description ?? '');
      setBaseRole(role.base_role ?? 'member');
      const m = new Map();
      for (const c of role.capabilities ?? []) {
        m.set(c.capability, c.granted);
      }
      setOverrides(m);
    } else {
      setName('');
      setDescription('');
      setBaseRole('member');
      setOverrides(new Map());
    }
    setError(null);
    setPending(false);
    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open, isEdit, role]);

  // Esc dismisses unless pending — same idiom as the other modals.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape' && !pending) onClose?.();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, pending, onClose]);

  // Group capabilities by group name for the table layout.
  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const cap of CAPABILITIES) {
      if (!byGroup.has(cap.group)) byGroup.set(cap.group, []);
      byGroup.get(cap.group).push(cap);
    }
    return Array.from(byGroup.entries());
  }, []);

  if (!open) return null;

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && !pending;

  // Build the capabilities array the RPC wants from the override Map. Only
  // rows that DIFFER from the base tier's default end up as overrides —
  // the absence is "inherit". This matches the resolution rule in
  // has_capability() so what the user sees is what RLS will enforce.
  const buildCapabilitiesPayload = () => {
    const out = [];
    for (const cap of CAPABILITIES) {
      if (!overrides.has(cap.id)) continue;
      const overrideValue = overrides.get(cap.id);
      const baseDefault = resolveCapability(baseRole, cap.id, []);
      // Skip overrides that match the base — they'd be no-ops AND would
      // become stale if the user later switches the base tier. (e.g. user
      // explicitly granted 'files.view' on a Member base; that capability
      // is granted by default for Member, so the override is redundant.)
      if (overrideValue === baseDefault) continue;
      out.push({ capability: cap.id, granted: overrideValue });
    }
    return out;
  };

  const handleSave = async (e) => {
    e?.preventDefault?.();
    if (!canSave) return;
    setPending(true);
    setError(null);
    const payload = {
      name: trimmedName,
      description: description.trim(),
      baseRole,
      capabilities: buildCapabilitiesPayload(),
    };
    let result;
    if (isEdit) {
      result = await updateCustomRole({ id: role.id, ...payload });
    } else {
      result = await createCustomRole({ projectId, ...payload });
    }
    setPending(false);
    if (result.error) {
      setError(result.error.message || 'Could not save the role.');
      return;
    }
    // create returns the new role id in result.data; update returns null.
    const savedId = isEdit ? role.id : result.data;
    onSaved?.(savedId);
    onClose?.();
  };

  const handleBackdropMouseDown = (e) => {
    if (pending) return;
    if (e.target === e.currentTarget) onClose?.();
  };

  const cycleOverride = (capId) => {
    setOverrides((prev) => {
      const next = new Map(prev);
      const baseDefault = resolveCapability(baseRole, capId, []);
      if (!next.has(capId)) {
        // From "inherited" → flip to the opposite of the base default.
        next.set(capId, !baseDefault);
      } else if (next.get(capId) === !baseDefault) {
        // From "explicit override" → back to inherited.
        next.delete(capId);
      } else {
        // From "same as base, explicitly set" → flip to opposite.
        next.set(capId, !baseDefault);
      }
      return next;
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        className="modal-card custom-role-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-role-editor-title"
      >
        <h3 id="custom-role-editor-title" className="modal-title">
          {isEdit ? 'Edit custom role' : 'Create custom role'}
        </h3>
        <p className="modal-message">
          {isEdit
            ? 'Update the role’s capabilities. Members assigned to it pick up the changes immediately.'
            : 'Pick a base tier, then add or revoke specific capabilities on top of it.'}
        </p>

        <form onSubmit={handleSave}>
          <label htmlFor="cre-name" className="invite-modal-label">Name</label>
          <input
            id="cre-name"
            ref={nameRef}
            type="text"
            className="invite-modal-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Designer"
            maxLength={50}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />

          <label htmlFor="cre-desc" className="invite-modal-label">Description</label>
          <textarea
            id="cre-desc"
            className="invite-modal-input custom-role-editor-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this role for? Optional."
            rows={2}
            maxLength={200}
            disabled={pending}
          />

          <span className="invite-modal-label">Base tier</span>
          <div className="custom-role-editor-tiers">
            {['admin', 'member', 'viewer'].map((tier) => (
              <label
                key={tier}
                className={`custom-role-editor-tier role-${tier}${baseRole === tier ? ' is-active' : ''}`}
              >
                <input
                  type="radio"
                  name="cre-base"
                  value={tier}
                  checked={baseRole === tier}
                  onChange={() => setBaseRole(tier)}
                  disabled={pending}
                />
                <span className="custom-role-editor-tier-label">{builtInLabel(tier)}</span>
              </label>
            ))}
          </div>

          <span className="invite-modal-label">Capabilities</span>
          <p className="custom-role-editor-hint">
            Click a row to override the base tier’s default. An empty override
            means the row inherits from the tier you picked above.
          </p>

          <div className="custom-role-editor-caps">
            {groups.map(([group, caps]) => (
              <div key={group} className="custom-role-editor-cap-group">
                <div className="custom-role-editor-cap-group-title">{group}</div>
                {caps.map((cap) => {
                  const baseDefault = resolveCapability(baseRole, cap.id, []);
                  const hasOverride = overrides.has(cap.id);
                  const effective = hasOverride ? overrides.get(cap.id) : baseDefault;
                  const stateLabel = hasOverride
                    ? (effective ? 'Granted (override)' : 'Revoked (override)')
                    : (baseDefault ? 'Inherited (granted)' : 'Inherited (not granted)');
                  return (
                    <button
                      type="button"
                      key={cap.id}
                      className={`custom-role-editor-cap-row${effective ? ' is-granted' : ''}${hasOverride ? ' is-override' : ''}`}
                      onClick={() => cycleOverride(cap.id)}
                      disabled={pending}
                      title={`Click to ${hasOverride ? 'clear override' : 'override'}`}
                    >
                      <div className="custom-role-editor-cap-info">
                        <div className="custom-role-editor-cap-label">{cap.label}</div>
                        <div className="custom-role-editor-cap-hint">{cap.hint}</div>
                      </div>
                      <div className="custom-role-editor-cap-state">
                        <span className="custom-role-editor-cap-state-text">{stateLabel}</span>
                        <span className={`custom-role-editor-cap-pill${effective ? ' is-granted' : ' is-revoked'}`}>
                          {effective ? 'On' : 'Off'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {error && (
            <div className="invite-modal-error" role="alert">{error}</div>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn-cancel"
              onClick={onClose}
              disabled={pending}
            >Cancel</button>
            <button
              type="submit"
              className="modal-btn modal-btn-confirm"
              disabled={!canSave}
            >
              {pending ? 'Saving…' : (isEdit ? 'Save changes' : 'Create role')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
