import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CAPABILITIES,
  cycleCapability,
  resolveCapability,
  updateCustomRole,
} from '../lib/customRoles';
import { useProject } from '../context/ProjectContext';
import { useNotifications } from '../context/NotificationsContext';
import RoleBadge, { builtInLabel } from './RoleBadge';
import Tooltip from './Tooltip';
import '../pages/Projects/ProjectDossier.css';

// Roles tab — "Editorial Dossier" layout (Claude Design handoff
// `docvex-project-redesign`): a role-catalog card grid on top + a clean
// capability matrix table below. Visually mirrors the prototype's roles-tab
// but is wired to the REAL capability model (lib/customRoles): 4 built-in
// tiers + N custom roles, tri-state inherit/grant/revoke on custom cells,
// optimistic overlay + debounced persist. Built-in cells are read-only.
//
// Replaces the grid-based RoleCapabilityMatrix on the Project dossier.
// Props mirror that component so the parent (ProjectOverview) wiring is
// unchanged save for the extra `members` (for per-role headcounts).

const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);
const CheckIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const BUILT_IN_TIERS = ['owner', 'admin', 'member', 'viewer'];

// Static descriptions for the built-in tiers — they track the real
// TIER_DEFAULTS capability matrix in lib/customRoles, not the prototype's
// (which referenced AI/Project caps this project doesn't have).
const BUILT_IN_DESC = {
  owner:  'Full control of the project. One per project.',
  admin:  'Manage members, approve releases, and manage custom roles.',
  member: 'View, upload, and delete own files. The default for invitees.',
  viewer: 'Read-only access. Cannot upload or propose changes.',
};

const PERSIST_DEBOUNCE_MS = 300;

// Group capabilities by their `group` field, preserving first-seen order.
function groupCapabilities() {
  const order = [];
  const byGroup = new Map();
  for (const cap of CAPABILITIES) {
    if (!byGroup.has(cap.group)) { byGroup.set(cap.group, []); order.push(cap.group); }
    byGroup.get(cap.group).push(cap);
  }
  return order.map((g) => [g, byGroup.get(g)]);
}

function sameOverrideSet(a, b) {
  const ax = (a || []).map((c) => `${c.capability}:${c.granted ? 1 : 0}`).sort();
  const bx = (b || []).map((c) => `${c.capability}:${c.granted ? 1 : 0}`).sort();
  if (ax.length !== bx.length) return false;
  for (let i = 0; i < ax.length; i += 1) if (ax[i] !== bx[i]) return false;
  return true;
}

// One matrix cell. Built-in cells are locked (documentation). Custom cells
// cycle inherit → grant → revoke on click; `override` adds a ring so it's
// clear the value differs from the inherited base.
function CapCell({ granted, override, locked, onToggle }) {
  const title = locked
    ? 'Built-in tier — capability fixed'
    : override
      ? (granted ? 'Granted (override) — click to clear' : 'Revoked (override) — click to clear')
      : (granted ? 'Inherited: allowed — click to override' : 'Inherited: denied — click to override');
  return (
    <button
      type="button"
      className={`pjd-cap-cell ${granted ? 'on' : 'off'}${locked ? ' locked' : ''}${override ? ' is-override' : ''}`}
      onClick={locked ? undefined : onToggle}
      disabled={locked}
      title={title}
      aria-label={title}
    >
      {granted ? CheckIcon : <span className="pjd-cap-dot" />}
    </button>
  );
}

export default function RolesDossier({ isAdmin, members = [], onCreateRole, onEditRole, onDeleteRole }) {
  const { customRoles, refreshCustomRoles } = useProject();
  const { notify } = useNotifications();

  const [overlay, setOverlay] = useState({});
  const overlayRef = useRef(overlay);
  useEffect(() => { overlayRef.current = overlay; }, [overlay]);
  const persistTimersRef = useRef(new Map());

  const groups = useMemo(groupCapabilities, []);

  // Per-role headcounts from the real member roster. A member holds a
  // custom role when custom_role_id matches; otherwise they hold the plain
  // built-in tier in their `role` column.
  const builtinCount = useCallback(
    (tier) => members.filter((m) => m.role === tier && !m.custom_role_id).length,
    [members],
  );
  const customCount = useCallback(
    (crId) => members.filter((m) => m.custom_role_id === crId).length,
    [members],
  );

  const effectiveCaps = useCallback(
    (role) => overlay[role.id] ?? role.capabilities ?? [],
    [overlay],
  );

  // Retire overlay entries once the persisted catalog catches up (realtime
  // or explicit refresh), and drop entries for roles deleted server-side.
  useEffect(() => {
    setOverlay((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [roleId, optimisticCaps] of Object.entries(prev)) {
        const serverRole = customRoles.find((r) => r.id === roleId);
        if (!serverRole) { delete next[roleId]; changed = true; continue; }
        if (sameOverrideSet(serverRole.capabilities, optimisticCaps)) { delete next[roleId]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [customRoles]);

  useEffect(() => {
    const timers = persistTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); timers.clear(); };
  }, []);

  const schedulePersist = useCallback((role) => {
    const existing = persistTimersRef.current.get(role.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      persistTimersRef.current.delete(role.id);
      const pendingCaps = overlayRef.current[role.id];
      if (!pendingCaps) return;
      const { error } = await updateCustomRole({
        id: role.id,
        name: role.name,
        description: role.description ?? null,
        baseRole: role.base_role,
        capabilities: pendingCaps,
      });
      if (error) {
        setOverlay((curr) => { const n = { ...curr }; delete n[role.id]; return n; });
        notify({
          category: 'role',
          variant: 'error',
          title: 'Could not save capability change',
          body: error.message || 'The server rejected the update.',
        });
        return;
      }
      refreshCustomRoles?.();
    }, PERSIST_DEBOUNCE_MS);
    persistTimersRef.current.set(role.id, timer);
  }, [notify, refreshCustomRoles]);

  const handleCellClick = useCallback((role, capId) => {
    if (!isAdmin) return;
    setOverlay((curr) => {
      const current = curr[role.id] ?? role.capabilities ?? [];
      const next = cycleCapability(role.base_role, capId, current);
      return { ...curr, [role.id]: next };
    });
    schedulePersist(role);
  }, [isAdmin, schedulePersist]);

  // Catalog cards: built-ins first, then customs.
  const catalog = [
    ...BUILT_IN_TIERS.map((tier) => ({ kind: 'builtin', id: tier, tier })),
    ...customRoles.map((cr) => ({ kind: 'custom', id: cr.id, role: cr })),
  ];
  // Matrix columns: same order.
  const columns = catalog;

  return (
    <div className="pjd-roles">
      {/* Role catalog */}
      <section className="pjd-panel">
        <div className="pjd-panel-head">
          <div>
            <div className="pjd-panel-title">Role catalog</div>
            <p className="pjd-panel-sub">
              Built-in tiers are fixed. Create custom roles to fine-tune capabilities for specific people.
            </p>
          </div>
          {isAdmin && (
            <button type="button" className="pjd-btn-primary" onClick={onCreateRole}>
              {PlusIcon} New custom role
            </button>
          )}
        </div>

        <div className="pjd-role-cards">
          {catalog.map((c) => {
            const isCustom = c.kind === 'custom';
            const count = isCustom ? customCount(c.id) : builtinCount(c.tier);
            const base = isCustom ? c.role.base_role : c.tier;
            const desc = isCustom ? (c.role.description || 'Custom role.') : BUILT_IN_DESC[c.tier];
            return (
              <div key={c.id} className={`pjd-role-card${isCustom ? ' is-custom' : ''}`}>
                <div className="pjd-role-card-head">
                  <RoleBadge role={base} customRole={isCustom ? c.role : null} />
                  {isCustom && <span className="pjd-role-base-tag">inherits {builtInLabel(base)}</span>}
                </div>
                <div className="pjd-role-card-count">
                  <strong>{count}</strong> {count === 1 ? 'person' : 'people'}
                </div>
                <p className="pjd-role-card-desc">{desc}</p>
                {isCustom && isAdmin && (
                  <div className="pjd-role-card-actions">
                    <button type="button" className="pjd-btn-ghost pjd-btn-xs" onClick={() => onEditRole?.(c.role)}>Edit</button>
                    <button type="button" className="pjd-btn-ghost pjd-btn-xs pjd-btn-danger" onClick={() => onDeleteRole?.(c.role)}>Delete</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Capability matrix */}
      <section className="pjd-panel">
        <div className="pjd-panel-head">
          <div>
            <div className="pjd-panel-title">Capability matrix</div>
            <p className="pjd-panel-sub">
              Rows are capabilities, columns are roles. {isAdmin ? 'Click a custom-role cell to grant or revoke.' : 'Built-in tiers are read-only.'}
            </p>
          </div>
        </div>

        <div className="pjd-cap-wrap">
          <table className="pjd-cap-matrix">
            <thead>
              <tr>
                <th className="pjd-cap-cap-th">Capability</th>
                {columns.map((c) => (
                  <th key={c.id} className={c.kind === 'custom' ? 'is-custom' : ''}>
                    <RoleBadge role={c.kind === 'custom' ? c.role.base_role : c.tier} customRole={c.kind === 'custom' ? c.role : null} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([groupName, groupCaps]) => (
                <React.Fragment key={groupName}>
                  <tr className="pjd-cap-group">
                    <td colSpan={columns.length + 1}>{groupName}</td>
                  </tr>
                  {groupCaps.map((cap) => (
                    <tr key={cap.id}>
                      <td className="pjd-cap-cap-cell">
                        <Tooltip content={cap.hint}><span>{cap.label}</span></Tooltip>
                      </td>
                      {columns.map((c) => {
                        if (c.kind === 'builtin') {
                          const granted = resolveCapability(c.tier, cap.id, []);
                          return (
                            <td key={c.id}><CapCell granted={granted} locked /></td>
                          );
                        }
                        const caps = effectiveCaps(c.role);
                        const granted = resolveCapability(c.role.base_role, cap.id, caps);
                        const override = caps.some((x) => x.capability === cap.id);
                        return (
                          <td key={c.id}>
                            <CapCell
                              granted={granted}
                              override={override}
                              locked={!isAdmin}
                              onToggle={() => handleCellClick(c.role, cap.id)}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {customRoles.length === 0 && (
          <p className="pjd-cap-empty">
            {isAdmin
              ? 'No custom roles yet — use “New custom role” above to create one.'
              : 'No custom roles defined for this project.'}
          </p>
        )}
      </section>
    </div>
  );
}
