import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
// DOMRects + cursor coords are viewport px; the top/transform/SVG coordinates
// we set are layout px — under the app's CSS-zoom downscale the two differ
// (see lib/appZoom). viewportTop, pan and the connector geometry are all kept
// in LAYOUT px.
import { toLayoutPx } from '../../lib/appZoom';
import { builtInLabel } from '../../components/RoleBadge';
import StatusBadge from '../../components/StatusBadge';

// Permission tiers in strongest → weakest order. The team-tree lays cards
// out left-to-right in this order; empty tiers are skipped so a team of
// owner + viewers shows two columns connected directly, not four with two
// empty placeholders in between.
const TIER_ORDER = ['owner', 'admin', 'member', 'viewer'];
const TIER_LABEL = {
  owner: 'Owner',
  admin: 'Admins',
  member: 'Members',
  // viewer → "Clients" per the app-wide rename in RoleBadge.builtInLabel.
  viewer: 'Clients',
};

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

// L-shaped connector from (x1, y1) to (x2, y2). `horizontalFirst=true` exits
// the start point horizontally and turns vertical at the bend (used when the
// start is a card's right edge); false exits vertically and turns horizontal
// near the end (used when the start is the central junction). Corner radius
// clamps to half of each leg so the rounded bend never overshoots the line.
const CORNER_RADIUS = 8;
function lShape(x1, y1, x2, y2, horizontalFirst) {
  if (y1 === y2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const r = Math.max(0, Math.min(CORNER_RADIUS, Math.abs(dx) / 2, Math.abs(dy) / 2));
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (horizontalFirst) {
    return `M ${x1} ${y1} H ${x2 - sx * r} Q ${x2} ${y1} ${x2} ${y1 + sy * r} V ${y2}`;
  }
  return `M ${x1} ${y1} V ${y2 - sy * r} Q ${x1} ${y2} ${x1 + sx * r} ${y2} H ${x2}`;
}

function TreeAvatar({ profile }) {
  const avatarUrl = profile?.avatar_url;
  const initial = (profile?.email || profile?.full_name || '?').charAt(0).toUpperCase();
  const status = profile?.status;
  const avatarEl = avatarUrl ? (
    <img className="tree-card-avatar" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="tree-card-avatar tree-card-avatar-fallback">{initial}</span>
  );
  return (
    <span className="tree-card-avatar-wrap">
      {avatarEl}
      <StatusBadge status={status} size="sm" ringColor="var(--bg-card)" />
    </span>
  );
}

// Visual org chart for a project's membership. Cards are arranged in
// tier columns (owner → admin → member → viewer) and connected with
// curved SVG paths that fan from each card to a per-gap junction point
// and back out — same look as the Supabase schema-diagram relationship
// lines. Connector geometry is recomputed in a useLayoutEffect (refs +
// getBoundingClientRect) and re-fired by a ResizeObserver so window
// resizes, font load, and async avatar images don't leave the lines stale.
export default function TeamTree({ members, customRoles }) {
  const viewportRef = useRef(null);
  const containerRef = useRef(null);
  // user_id → card DOM node. Populated by ref callbacks; entries are
  // dropped when a row unmounts so the recompute loop never reads stale
  // nodes after a removal.
  const cardRefs = useRef({});
  const [edges, setEdges] = useState([]);

  // Pan offset applied via CSS transform on the inner container. Lives in
  // state so React re-renders the transform; the active-drag delta lives
  // in dragRef (mutable, no re-render per mousemove). Centered once on
  // initial layout (via hasCenteredRef) — subsequent member additions
  // don't snap the user's view back.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const hasCenteredRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  // Viewport's top edge tracks the bottom of the .project-tabs bar so the
  // canvas starts flush under the tabs regardless of header/banner height
  // above. Measured at runtime + on layout changes (window resize, banner
  // mount/unmount, sidebar expand/collapse — all flow through ResizeObserver
  // on document.body).
  const [viewportTop, setViewportTop] = useState(0);

  // Bucket members into tier columns. Custom-role assignment promotes the
  // row's tier to the custom role's base_role so a member with a custom
  // role of base_role='admin' sits in the Admins column, not Members.
  const tiers = useMemo(() => {
    const buckets = { owner: [], admin: [], member: [], viewer: [] };
    for (const m of members) {
      const customRole = m.custom_role_id
        ? customRoles.find((cr) => cr.id === m.custom_role_id) || null
        : null;
      const baseTier = customRole?.base_role ?? m.role;
      if (!buckets[baseTier]) continue;
      buckets[baseTier].push({ ...m, _customRole: customRole });
    }
    return TIER_ORDER
      .map((id) => ({ id, label: TIER_LABEL[id], members: buckets[id] }))
      .filter((t) => t.members.length > 0);
  }, [members, customRoles]);

  // Measure the bottom of the project-tabs bar and use it as the viewport's
  // top edge. Re-runs on window resize and on any document body resize
  // (catches banner mount/unmount + sidebar width changes without needing
  // to wire a prop or context value into TeamTree).
  useLayoutEffect(() => {
    const measure = () => {
      const tabs = document.querySelector('.project-tabs');
      if (tabs) setViewportTop(toLayoutPx(tabs.getBoundingClientRect().bottom));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Centre the tree inside the viewport on first paint. Done in a
  // useLayoutEffect so we read offsetWidth/offsetHeight (layout box,
  // unaffected by the transform we're about to apply) before the browser
  // commits a frame — avoids a one-frame flash where the tree sits at
  // (0,0) before snapping to centre.
  useLayoutEffect(() => {
    if (hasCenteredRef.current) return;
    // Wait until the viewport has its real top (set by the measure effect)
    // before reading clientHeight — otherwise the first read happens while
    // the viewport still spans from y=0 and cy is computed against a
    // dimension that's about to change in the next commit.
    if (viewportTop === 0) return;
    const viewport = viewportRef.current;
    const content = containerRef.current;
    if (!viewport || !content) return;
    if (tiers.length === 0) return;
    const cx = (viewport.clientWidth - content.offsetWidth) / 2;
    const cy = (viewport.clientHeight - content.offsetHeight) / 2;
    setPan({ x: cx, y: cy });
    hasCenteredRef.current = true;
  }, [tiers, viewportTop]);

  // Mouse-drag panning. Listeners are bound to window (not the viewport)
  // so the pan keeps tracking even if the cursor leaves the viewport
  // during a drag — matches the Figma/Miro canvas expectation.
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = toLayoutPx(e.clientX - d.startX);
      const dy = toLayoutPx(e.clientY - d.startY);
      setPan({ x: d.baseX + dx, y: d.baseY + dy });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleMouseDown = (e) => {
    // Left button only — middle/right click should fall through to native
    // browser context-menu / autoscroll behavior even if we're not using
    // those today.
    if (e.button !== 0) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: pan.x,
      baseY: pan.y,
    };
    setIsDragging(true);
    e.preventDefault();
  };

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const recompute = () => {
      if (tiers.length < 2) {
        setEdges([]);
        return;
      }
      const cRect = container.getBoundingClientRect();

      const tierRects = tiers.map((tier) =>
        tier.members
          .map((m) => {
            const node = cardRefs.current[m.user_id];
            if (!node) return null;
            const r = node.getBoundingClientRect();
            return {
              left: toLayoutPx(r.left - cRect.left),
              right: toLayoutPx(r.right - cRect.left),
              cy: toLayoutPx((r.top + r.bottom) / 2 - cRect.top),
            };
          })
          .filter(Boolean),
      );

      const next = [];
      for (let i = 0; i < tierRects.length - 1; i += 1) {
        const left = tierRects[i];
        const right = tierRects[i + 1];
        if (!left.length || !right.length) continue;

        // Junction point sits in the horizontal middle of the gap between
        // the two columns, vertically centred between the spread of card
        // centres on both sides. All curves on this side meet there before
        // fanning back out to the next column — gives the clean N→1→M look.
        const leftEdgeX = Math.max(...left.map((r) => r.right));
        const rightEdgeX = Math.min(...right.map((r) => r.left));
        const jx = (leftEdgeX + rightEdgeX) / 2;
        const allCys = [...left.map((r) => r.cy), ...right.map((r) => r.cy)];
        const jy = (Math.min(...allCys) + Math.max(...allCys)) / 2;

        // Orthogonal L-shape: horizontal stub off the card edge, rounded
        // bend, vertical run to the junction. Corner radius clamps to half
        // of either leg so short segments don't get a pinched curve.
        for (const r of left) {
          next.push(lShape(r.right, r.cy, jx, jy, true));
        }
        for (const r of right) {
          next.push(lShape(jx, jy, r.left, r.cy, false));
        }
      }
      setEdges(next);
    };

    recompute();

    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    for (const node of Object.values(cardRefs.current)) {
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [tiers]);

  if (members.length === 0) {
    return <div className="project-dashboard-empty">No members yet.</div>;
  }

  return (
    <div
      ref={viewportRef}
      className={`team-tree-viewport${isDragging ? ' is-dragging' : ''}`}
      onMouseDown={handleMouseDown}
      style={{ top: `${viewportTop}px` }}
    >
      <div
        className="team-tree"
        ref={containerRef}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
      >
        <svg className="team-tree-edges" aria-hidden="true">
          {edges.map((d, i) => (
            <path key={i} d={d} fill="none" />
          ))}
        </svg>
        {tiers.map((tier) => (
        <div key={tier.id} className="tree-tier">
          <div className="tier-label">{tier.label}</div>
          <div className="tier-cards">
            {tier.members.map((m) => {
              const customRole = m._customRole;
              const baseTier = customRole?.base_role ?? m.role;
              const roleLabel = customRole?.name ?? builtInLabel(m.role);
              return (
                <div
                  key={m.user_id}
                  ref={(el) => {
                    if (el) cardRefs.current[m.user_id] = el;
                    else delete cardRefs.current[m.user_id];
                  }}
                  className="tree-card"
                  data-card-id={m.user_id}
                >
                  <TreeAvatar profile={m.profile} />
                  <div className="tree-card-text">
                    <div className="tree-card-name">{getMemberName(m.profile)}</div>
                    {m.profile?.email && getMemberName(m.profile) !== m.profile.email && (
                      <div className="tree-card-email">{m.profile.email}</div>
                    )}
                    <span
                      className={`project-dashboard-role role-${baseTier}${
                        customRole ? ' role-custom' : ''
                      }`}
                    >
                      {roleLabel}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        ))}
      </div>
    </div>
  );
}
