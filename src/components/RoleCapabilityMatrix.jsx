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
import './RoleCapabilityMatrix.css';

// Pencil + trash icons for the custom-role column header actions. Same
// stroke recipe as the rest of the inline SVG icons in the codebase so they
// inherit `color` from their parent via `currentColor`.
const PencilIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
  </svg>
);

const TrashIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

const PlusIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

// Built-in role columns. The four base tiers in display order. `viewer` is
// labeled "Client" everywhere user-facing (see builtInLabel in RoleBadge).
const BUILT_IN_COLUMNS = ['owner', 'admin', 'member', 'viewer'];

// Debounce window for batching rapid cell clicks on the same custom role
// into a single updateCustomRole round-trip. Optimistic UI updates fire
// instantly regardless; this only delays the persist call.
const PERSIST_DEBOUNCE_MS = 300;

// Group capabilities by their `group` field so we can stamp a section
// sub-header before each block (matches CustomRoleEditor's row grouping).
// Output: `[[group, caps[]], ...]` in CAPABILITIES order — first occurrence
// of each group wins the position, so reordering CAPABILITIES reorders the
// matrix rows automatically.
function groupCapabilities() {
  const order = [];
  const byGroup = new Map();
  for (const cap of CAPABILITIES) {
    if (!byGroup.has(cap.group)) {
      byGroup.set(cap.group, []);
      order.push(cap.group);
    }
    byGroup.get(cap.group).push(cap);
  }
  return order.map((g) => [g, byGroup.get(g)]);
}

// Deep equality on the override set: two capability lists are equivalent
// when they contain the same (capability, granted) pairs regardless of
// array order (the RPC may return them in a different order than we
// sent). Used to retire overlay entries once realtime catches up.
function sameOverrideSet(a, b) {
  const ax = (a || []).map((c) => `${c.capability}:${c.granted ? 1 : 0}`).sort();
  const bx = (b || []).map((c) => `${c.capability}:${c.granted ? 1 : 0}`).sort();
  if (ax.length !== bx.length) return false;
  for (let i = 0; i < ax.length; i += 1) if (ax[i] !== bx[i]) return false;
  return true;
}

// Matrix layout for the Roles tab on Project Overview. Columns = roles
// (4 built-in + N custom + a `+` button); rows = capabilities; cells =
// allow/deny dot. Built-in cells are read-only documentation; custom
// cells tri-state-cycle on click (inherit → grant → revoke → inherit).
//
// Props:
//   isAdmin             — true for owner/admin; gates write affordances.
//   onCreateRole()      — called by the `+` header to open the editor in
//                         create mode (parent sets editorTarget = null).
//   onEditRole(role)    — called by the pencil icon to open the editor in
//                         edit mode for the given custom role row.
//   onDeleteRole(role)  — called by the trash icon to open the delete
//                         confirm modal for the given custom role row.
export default function RoleCapabilityMatrix({
  isAdmin,
  onCreateRole,
  onEditRole,
  onDeleteRole,
}) {
  const { customRoles, refreshCustomRoles } = useProject();
  const { notify } = useNotifications();

  // Optimistic overlay: { [roleId]: capabilitiesArray }. A cell click
  // updates this map instantly so the dot flips with no round-trip wait.
  // The persist call (debounced) sends the same array to the server;
  // realtime reconciles ProjectContext.customRoles afterward. Entries are
  // cleared when the server-side row matches the overlay.
  const [overlay, setOverlay] = useState({});
  // Ref mirror of overlay, kept in sync via the effect below. Lets the
  // debounced setTimeout callbacks read the LATEST overlay state at fire
  // time (not the state captured when the click happened) so coalesced
  // clicks all land in one round-trip with the most recent payload.
  const overlayRef = useRef(overlay);
  useEffect(() => { overlayRef.current = overlay; }, [overlay]);

  // Per-role debounce bookkeeping. Each role can have at most one pending
  // setTimeout; rapid clicks replace the queued payload via the ref above
  // rather than queuing multiple RPCs.
  const persistTimersRef = useRef(new Map()); // roleId → setTimeout id

  const groups = useMemo(groupCapabilities, []);

  // Resolve a role's effective capabilities array: prefer the optimistic
  // overlay (a pending flip the user just made) over the persisted state
  // from ProjectContext. Returns the raw `{capability, granted}[]` array
  // listCustomRoles produces — the same shape resolveCapability accepts.
  const effectiveCaps = useCallback(
    (role) => overlay[role.id] ?? role.capabilities ?? [],
    [overlay],
  );

  // Clear overlay entries whose server-side state has caught up. Runs every
  // time the persisted catalog changes (realtime or refresh). Without this
  // the overlay would shadow the canonical state forever even after the
  // server confirms the write.
  useEffect(() => {
    setOverlay((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [roleId, optimisticCaps] of Object.entries(prev)) {
        const serverRole = customRoles.find((r) => r.id === roleId);
        if (!serverRole) {
          // Role was deleted server-side — drop the overlay entry.
          delete next[roleId];
          changed = true;
          continue;
        }
        if (sameOverrideSet(serverRole.capabilities, optimisticCaps)) {
          delete next[roleId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [customRoles]);

  // Cleanup any pending timers on unmount so they don't fire after the
  // component is gone. The Map itself is a ref so it survives renders.
  useEffect(() => {
    const timers = persistTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Schedule the actual updateCustomRole RPC. Debounced per-role so rapid
  // clicks on the same role's cells coalesce. The payload is read fresh
  // from overlayRef at fire time so the most recent state lands in one
  // round-trip even if the user clicked multiple cells during the window.
  const schedulePersist = useCallback((role) => {
    const existingTimer = persistTimersRef.current.get(role.id);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
      persistTimersRef.current.delete(role.id);
      const pendingCaps = overlayRef.current[role.id];
      if (!pendingCaps) return; // overlay already cleared (realtime won)

      const { error } = await updateCustomRole({
        id: role.id,
        name: role.name,
        description: role.description ?? null,
        baseRole: role.base_role,
        capabilities: pendingCaps,
      });

      if (error) {
        // Roll back the optimistic overlay so the UI snaps back to the
        // persisted state — but ONLY if no newer click landed during the
        // in-flight RPC. If the overlay still holds the exact payload we tried
        // to persist (same array reference — each click makes a fresh one), it's
        // safe to clear. Otherwise a newer edit is pending under its own timer;
        // deleting here would silently discard that click, so leave it be.
        if (overlayRef.current[role.id] === pendingCaps) {
          setOverlay((curr) => {
            const next = { ...curr };
            delete next[role.id];
            return next;
          });
        }
        notify({
          category: 'role',
          variant: 'error',
          title: 'Could not save capability change',
          body: error.message || 'The server rejected the update.',
        });
        return;
      }
      // On success, ask ProjectContext to refetch the catalog. Realtime
      // also fires; the explicit refresh just gives instant confirmation
      // and the overlay-clearing effect above will retire the entry once
      // the server response matches our optimistic state.
      refreshCustomRoles?.();
    }, PERSIST_DEBOUNCE_MS);

    persistTimersRef.current.set(role.id, timer);
  }, [notify, refreshCustomRoles]);

  // Cell click handler — only fires for custom-role cells when the actor
  // is admin+. Computes the next capability set via the shared cycle
  // helper, patches the overlay, schedules the persist call.
  const handleCellClick = useCallback((role, capId) => {
    if (!isAdmin) return;
    setOverlay((curr) => {
      const current = curr[role.id] ?? role.capabilities ?? [];
      const next = cycleCapability(role.base_role, capId, current);
      return { ...curr, [role.id]: next };
    });
    schedulePersist(role);
  }, [isAdmin, schedulePersist]);

  // Pre-build column-count for grid-template-columns. 1 (feature label) +
  // 4 (built-in) + customRoles.length + 1 (plus button column).
  const columnCount = 1 + BUILT_IN_COLUMNS.length + customRoles.length + 1;

  return (
    <section className="role-matrix-section">
      <div className="role-matrix-section-header">
        <h2 className="role-matrix-section-title">Roles &amp; capabilities</h2>
        <p className="role-matrix-section-subtitle">
          Every capability for every role on one screen. Built-in tiers are
          read-only; custom-role cells flip on click between inherit, grant,
          and revoke. Add a custom role with the <strong>+</strong> column.
        </p>
      </div>

      <div
        className="role-matrix-scroll"
        // CSS variable is read by the grid template — keeps the column
        // count out of the stylesheet so dynamic role counts work without
        // a per-render style object on every cell.
        style={{ '--role-matrix-column-count': columnCount }}
      >
        <div className="role-matrix" role="table" aria-label="Roles and capabilities">
          {/* ── Header row ───────────────────────────────────────────── */}
          <div className="role-matrix-row role-matrix-row-header" role="row">
            <div className="role-matrix-cell role-matrix-cell-corner" role="columnheader" />

            {BUILT_IN_COLUMNS.map((tier) => (
              <div
                key={tier}
                className={`role-matrix-cell role-matrix-cell-header role-matrix-cell-header-builtin role-${tier}`}
                role="columnheader"
              >
                <RoleBadge role={tier} />
              </div>
            ))}

            {customRoles.map((cr) => (
              <div
                key={cr.id}
                className="role-matrix-cell role-matrix-cell-header role-matrix-cell-header-custom"
                role="columnheader"
              >
                <RoleBadge role={cr.base_role} customRole={cr} />
                <span className="role-matrix-header-sub">
                  extends {builtInLabel(cr.base_role)}
                </span>
                {isAdmin && (
                  <div className="role-matrix-header-actions">
                    <Tooltip content="Edit role">
                      <button
                        type="button"
                        className="role-matrix-header-icon-btn"
                        onClick={() => onEditRole?.(cr)}
                        aria-label={`Edit ${cr.name}`}
                      >
                        {PencilIcon}
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete role">
                      <button
                        type="button"
                        className="role-matrix-header-icon-btn role-matrix-header-icon-btn-destructive"
                        onClick={() => onDeleteRole?.(cr)}
                        aria-label={`Delete ${cr.name}`}
                      >
                        {TrashIcon}
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
            ))}

            {/* + column for adding a new custom role. Hidden (rendered as
                an empty cell) for non-admins so the grid stays the same
                column count for everyone — keeps row alignment stable. */}
            <div className="role-matrix-cell role-matrix-cell-header role-matrix-cell-header-add" role="columnheader">
              {isAdmin && (
                <Tooltip content="Add custom role">
                  <button
                    type="button"
                    className="role-matrix-add-btn"
                    onClick={onCreateRole}
                    aria-label="Add custom role"
                  >
                    {PlusIcon}
                  </button>
                </Tooltip>
              )}
            </div>
          </div>

          {/* ── Body: group sub-header + capability rows for each group ── */}
          {groups.map(([groupName, groupCaps]) => (
            <React.Fragment key={groupName}>
              <div className="role-matrix-row role-matrix-row-group" role="row">
                <div className="role-matrix-cell role-matrix-cell-group-label" role="rowheader">
                  {groupName}
                </div>
                {/* Empty cells under each role column for the group's
                    separator strip — they ensure the grid keeps its
                    column count even on the group-header rows. */}
                {Array.from({ length: columnCount - 1 }).map((_, i) => (
                  <div key={i} className="role-matrix-cell role-matrix-cell-group-spacer" />
                ))}
              </div>

              {groupCaps.map((cap) => (
                <div key={cap.id} className="role-matrix-row" role="row">
                  <Tooltip content={cap.hint}>
                    <div
                      className="role-matrix-cell role-matrix-cell-feature"
                      role="rowheader"
                    >
                      {cap.label}
                    </div>
                  </Tooltip>

                  {BUILT_IN_COLUMNS.map((tier) => {
                    const granted = resolveCapability(tier, cap.id, []);
                    return (
                      <div
                        key={tier}
                        className="role-matrix-cell role-matrix-cell-value role-matrix-cell-readonly"
                        role="cell"
                        aria-label={`${tier} ${cap.label}: ${granted ? 'allowed' : 'denied'}`}
                      >
                        <span
                          className={`role-matrix-dot${granted ? ' is-granted' : ' is-revoked'}`}
                          aria-hidden="true"
                        />
                      </div>
                    );
                  })}

                  {customRoles.map((cr) => {
                    const roleCaps = effectiveCaps(cr);
                    const granted = resolveCapability(cr.base_role, cap.id, roleCaps);
                    const hasOverride = roleCaps.some((c) => c.capability === cap.id);
                    const interactive = isAdmin;
                    return (
                      <div
                        key={cr.id}
                        className={`role-matrix-cell role-matrix-cell-value${interactive ? '' : ' role-matrix-cell-readonly'}`}
                        role="cell"
                      >
                        <Tooltip content={hasOverride ? 'Override — click to clear' : 'Inherited — click to override'}>
                          <button
                            type="button"
                            className={`role-matrix-dot-btn${interactive ? '' : ' is-readonly'}`}
                            onClick={() => handleCellClick(cr, cap.id)}
                            disabled={!interactive}
                            aria-label={`${cr.name} ${cap.label}: ${granted ? 'allowed' : 'denied'}${hasOverride ? ' (override)' : ' (inherited)'}. Click to change.`}
                          >
                            <span
                              className={`role-matrix-dot${granted ? ' is-granted' : ' is-revoked'}${hasOverride ? ' is-override' : ''}`}
                              aria-hidden="true"
                            />
                          </button>
                        </Tooltip>
                      </div>
                    );
                  })}

                  {/* Empty cell under the + column to keep the grid aligned. */}
                  <div className="role-matrix-cell role-matrix-cell-add-spacer" />
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>

      {customRoles.length === 0 && (
        <p className="role-matrix-empty-hint">
          {isAdmin
            ? 'No custom roles yet — click the + column to create one.'
            : 'No custom roles defined for this project.'}
        </p>
      )}
    </section>
  );
}
