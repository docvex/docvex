import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
// Co-located styling — every consumer of useMorphPill gets the
// dropdown / confirm-panel CSS automatically. Previously these
// rules lived in ProjectFiles.css, which meant the hook only looked
// right on the Files page; consumers on other pages (Chat,
// future surfaces) had to remember to import an unrelated CSS file
// or the dropdown rendered with the bare tooltip styling.
import './useMorphPill.css';

// Shared morph-pill hook + portal renderer. Powers the same hover-
// tooltip → right-click-menu interaction the file grid uses on every
// surface (Cloud-tab FileCard, My-branch LocalFileCard). Lives here
// instead of inline so the FLIP animation + sticky-mode dismissal
// logic stays in one place — adding a third caller is a one-line
// change instead of another 100-line copy-paste.
//
// State machine:
//   tooltip  (hover)             — pillPos set, !menuMode, !confirming
//   menu     (right-click)       — pillPos set, menuMode, !confirming
//   confirm  (menu item w/      — pillPos set, menuMode, confirming
//             .confirm picked)
//
// Each transition runs the FLIP morph: snapshot old rect, let React
// commit the new shape, scale-down + animate-to-1. Same recipe in
// every direction so the visual feels uniform.
//
// Usage:
//   const morphPill = useMorphPill({
//     hoverContent: 'Tooltip text',
//     menuItems: [
//       { label: 'Open',  onClick: () => …, key: 'open' },
//       {
//         label: 'Hide',  onClick: () => onDelete?.(file),
//         danger: true,
//         confirm: {
//           title: 'Hide this file?',
//           message: 'The file will be removed from disk…',
//           confirmLabel: 'Hide',
//           cancelLabel: 'Cancel',
//         },
//       },
//     ],
//   });
//
// `menuItems` entries: `{ label, onClick, key?, danger?, disabled?, confirm? }`.
// When `confirm` is set, clicking the item morphs the pill into a
// confirmation panel instead of firing onClick directly. Confirm
// there runs onClick + closes; Cancel just closes.
//
// Falsy entries in menuItems are filtered, so callers can write
// `[itemA, condition && itemB, itemC]` and have the conditional
// collapse cleanly without per-render branching.
export function useMorphPill({ hoverContent, menuItems, prompt, className = '' }) {
  const [pillPos, setPillPos] = useState(null);
  const [menuMode, setMenuMode] = useState(false);
  // Item currently in its confirmation step (or null). Holds the
  // whole item so the panel can read title / message / labels / the
  // onClick to fire when the user confirms. Mutually exclusive with
  // the menu list — when this is set, the menu items aren't rendered.
  const [confirmingItem, setConfirmingItem] = useState(null);
  // Prompt mode — a confirm panel that ALSO carries a free-text input
  // (e.g. "reason for rejecting"). Opened directly via handleOpenPrompt
  // (a left-click, not the right-click menu) so the tooltip morphs
  // straight into the input panel. `prompt` config shape:
  //   { title?, message?, placeholder?, confirmLabel?, cancelLabel?,
  //     danger?, requireText?, onSubmit(text) }
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const pillRef = useRef(null);
  const oldPillRectRef = useRef(null);

  const handleMouseMove = (e) => {
    if (menuMode || promptOpen) return;
    setPillPos({ x: e.clientX, y: e.clientY });
  };
  const handleMouseLeave = () => {
    if (menuMode || promptOpen) return;
    setPillPos(null);
  };
  const handleContextMenu = (e) => {
    e.preventDefault();
    // Snapshot the pill's current (tooltip-size) rect BEFORE the
    // menu-mode flip so the FLIP effect below has a "from" size to
    // scale up from. Captured here in the event handler rather than
    // in the effect because by the time the effect runs the DOM is
    // already at menu-size.
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    setPillPos({ x: e.clientX, y: e.clientY });
    setMenuMode(true);
  };
  const closeMenu = () => {
    setMenuMode(false);
    setConfirmingItem(null);
    setPromptOpen(false);
    setPromptText('');
    setPromptBusy(false);
    setPillPos(null);
    oldPillRectRef.current = null;
  };

  // Left-click entry into prompt mode. Morphs the (already-showing,
  // from hover) tooltip straight into the input panel — snapshot the
  // tooltip rect first so the FLIP effect has a "from" shape. Keeps
  // the current cursor-anchored pillPos when present; falls back to
  // the trigger's own rect for keyboard activation (which reports a
  // 0,0 cursor).
  const handleOpenPrompt = (e) => {
    if (!prompt) return;
    e.preventDefault();
    e.stopPropagation();
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    const rect = e.currentTarget?.getBoundingClientRect?.();
    const x = e.clientX || (rect ? rect.left : 0);
    const y = e.clientY || (rect ? rect.bottom : 0);
    setPromptText('');
    setPromptBusy(false);
    setPillPos((prev) => prev || { x, y });
    setPromptOpen(true);
  };

  const handlePromptSubmit = async () => {
    if (!prompt || promptBusy) return;
    const text = promptText.trim();
    if (prompt.requireText && !text) return;
    setPromptBusy(true);
    try {
      await prompt.onSubmit?.(text);
    } finally {
      closeMenu();
    }
  };

  // Click handler for an item in the menu. If the item carries a
  // `confirm` payload, we morph the pill into a confirmation step
  // instead of firing the action. Otherwise the action runs and the
  // menu closes — behaviour matches the pre-confirm-step version.
  const handleMenuItemClick = (item) => {
    if (item.confirm) {
      // Snapshot CURRENT (menu) rect so the menu → confirm FLIP has
      // a "from" size. Same FLIP recipe the right-click step uses.
      if (pillRef.current) {
        oldPillRectRef.current = pillRef.current.getBoundingClientRect();
      }
      setConfirmingItem(item);
      return;
    }
    closeMenu();
    item.onClick?.();
  };

  const handleConfirmYes = () => {
    const item = confirmingItem;
    closeMenu();
    item?.onClick?.();
  };

  // Sticky-mode dismissal: outside click, Escape, or scroll. Applies
  // in BOTH menu and confirm modes — clicking outside the confirmation
  // is the same as Cancel; Escape too.
  useEffect(() => {
    if (!menuMode && !promptOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
    const onDown = (e) => {
      if (pillRef.current && pillRef.current.contains(e.target)) return;
      closeMenu();
    };
    const onScroll = () => closeMenu();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menuMode, promptOpen]);

  // Position-clamp — same recipe as the shared Tooltip: keep the pill
  // inside the viewport on both axes, snap on first mount so the CSS
  // transition doesn't visibly slide in from (0,0). Re-runs on menu-
  // mode AND confirm-mode flips too so each shape gets re-clamped.
  useLayoutEffect(() => {
    if (!pillPos) return;
    const pill = pillRef.current;
    if (!pill) return;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.max(8, Math.min(pillPos.x + 8, vw - 8 - w));
    const y = Math.max(8, Math.min(pillPos.y + 8, vh - 8 - h));
    const isFirstSet = !pill.style.transform;
    if (isFirstSet) {
      pill.style.transition = 'none';
      pill.style.transform = `translate(${x}px, ${y}px)`;
      void pill.offsetWidth;
      pill.style.transition = '';
    } else {
      pill.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [pillPos, menuMode, confirmingItem, promptOpen]);

  // FLIP morph — fires whenever the pill's RENDERED SHAPE changes,
  // not just on menu-mode entry. Three transitions all use the same
  // recipe:
  //   tooltip → menu     (handleContextMenu sets oldPillRectRef)
  //   menu    → confirm  (handleMenuItemClick sets oldPillRectRef)
  //   confirm → menu     (Cancel — sets oldPillRectRef inside the
  //                       confirm panel's Cancel onClick)
  //
  //   F (First) — captured as oldPillRectRef before the React commit.
  //   L (Last)  — measured here, after React has rendered the new shape.
  //   I (Invert) — apply an inline transform that scales the pill
  //               DOWN/UP so it visually matches the old shape.
  //   P (Play)  — transition back to scale(1) using a transform-only
  //               animation. Composites on the GPU, no layout thrash.
  useLayoutEffect(() => {
    const oldRect = oldPillRectRef.current;
    if (!oldRect) return;
    const pill = pillRef.current;
    if (!pill) return;
    const newRect = pill.getBoundingClientRect();
    if (newRect.width === 0 || newRect.height === 0) {
      oldPillRectRef.current = null;
      return;
    }
    const sx = oldRect.width / newRect.width;
    const sy = oldRect.height / newRect.height;
    const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(pill.style.transform || '');
    const tx = m ? parseFloat(m[1]) : 0;
    const ty = m ? parseFloat(m[2]) : 0;
    pill.style.transformOrigin = 'top left';
    pill.style.transition = 'none';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
    void pill.offsetWidth;
    pill.style.transition = 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)';
    pill.style.transform = `translate(${tx}px, ${ty}px) scale(1, 1)`;
    oldPillRectRef.current = null;
  }, [menuMode, confirmingItem, promptOpen]);

  // Cancel out of the confirm step back to the menu. Snapshots the
  // CURRENT (confirm panel) rect so the reverse FLIP shrinks the
  // confirm shape DOWN into the menu shape just like the forward
  // morph grew it up.
  const handleConfirmCancel = () => {
    if (pillRef.current) {
      oldPillRectRef.current = pillRef.current.getBoundingClientRect();
    }
    setConfirmingItem(null);
  };

  const filteredItems = (menuItems || []).filter(Boolean);

  // Render branches: confirm > menu > tooltip. Pill className gets a
  // modifier per state so the CSS can size + style each shape
  // distinctly while keeping the same root element so FLIP works.
  let content;
  let pillClassMod;
  if (promptOpen) {
    // Reuses the confirm panel's chrome (.is-menu shell + confirm
    // title/message/actions classes) and slots a textarea between the
    // message and the action row.
    pillClassMod = ' is-menu is-confirm is-prompt';
    const p = prompt || {};
    const isDanger = Boolean(p.danger);
    const submitDisabled = promptBusy || (p.requireText && !promptText.trim());
    content = (
      // The pill is portalled, but React replays its events through the
      // React tree — so without stopping them, clicks/keys here bubble to
      // whatever element rendered the pill (e.g. a selectable card) and
      // trigger its handlers. Stop click + keydown propagation so the
      // panel behaves like the standalone dialog it looks like.
      <div
        className="project-files-morph-confirm project-files-morph-prompt"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {p.title && (
          <div className="project-files-morph-confirm-title">{p.title}</div>
        )}
        {p.message && (
          <p className="project-files-morph-confirm-message">{p.message}</p>
        )}
        <textarea
          className="project-files-morph-prompt-input"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          placeholder={p.placeholder || ''}
          rows={3}
          autoFocus
          // Cmd/Ctrl+Enter submits; plain Enter stays a newline so the
          // reason can be multi-line. Keystrokes are kept from bubbling
          // to the host element (a Space/Enter there could toggle a
          // selectable card behind the portal). Escape is the exception
          // — it must propagate so the global dismiss handler closes us.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handlePromptSubmit();
            }
          }}
        />
        <div className="project-files-morph-confirm-actions">
          <button
            type="button"
            className="project-files-morph-confirm-btn project-files-morph-confirm-btn-cancel"
            onClick={closeMenu}
          >
            {p.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            className={`project-files-morph-confirm-btn ${isDanger ? 'project-files-morph-confirm-btn-danger' : 'project-files-morph-confirm-btn-primary'}`}
            onClick={handlePromptSubmit}
            disabled={submitDisabled}
          >
            {promptBusy ? '…' : (p.confirmLabel || 'Submit')}
          </button>
        </div>
      </div>
    );
  } else if (confirmingItem) {
    pillClassMod = ' is-menu is-confirm';
    const c = confirmingItem.confirm || {};
    const isDanger = Boolean(confirmingItem.danger);
    content = (
      <div className="project-files-morph-confirm">
        {c.title && (
          <div className="project-files-morph-confirm-title">{c.title}</div>
        )}
        {c.message && (
          <p className="project-files-morph-confirm-message">{c.message}</p>
        )}
        <div className="project-files-morph-confirm-actions">
          <button
            type="button"
            className="project-files-morph-confirm-btn project-files-morph-confirm-btn-cancel"
            onClick={handleConfirmCancel}
          >
            {c.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            className={`project-files-morph-confirm-btn ${isDanger ? 'project-files-morph-confirm-btn-danger' : 'project-files-morph-confirm-btn-primary'}`}
            onClick={handleConfirmYes}
            autoFocus
          >
            {c.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    );
  } else if (menuMode) {
    pillClassMod = ' is-menu';
    content = (
      <ul className="project-files-morph-list">
        {filteredItems.map((item, i) => (
          <li key={item.key || item.label || i} role="none">
            <button
              type="button"
              role="menuitem"
              className={`project-files-morph-item${item.danger ? ' project-files-morph-item-danger' : ''}`}
              onClick={() => handleMenuItemClick(item)}
              disabled={item.disabled || false}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    );
  } else {
    pillClassMod = '';
    content = <span className="project-files-morph-text">{hoverContent}</span>;
  }

  // Tooltip-mode pill grows visibly when hoverContent carries an
  // explicit newline (e.g. `Sent <date>\nEdited <date>`). Fully-
  // rounded ends (999px) only look right on a single-line pill; on
  // 2+ lines the half-circles pinch the corners and the shape reads
  // as a stretched stadium. Halving the radius for multi-line content
  // lets the longer pill keep a soft-corner look without going
  // sharp-rectangular. Driven by an `.is-multiline` modifier so the
  // visual rule lives in CSS.
  const isMultilineHover = !menuMode
    && !confirmingItem
    && typeof hoverContent === 'string'
    && hoverContent.includes('\n');
  const multilineMod = isMultilineHover ? ' is-multiline' : '';

  const node = pillPos ? createPortal(
    <div
      ref={pillRef}
      className={`tooltip project-files-morph-pill${pillClassMod}${multilineMod}${className ? ` ${className}` : ''}`}
      role={confirmingItem || promptOpen ? 'dialog' : menuMode ? 'menu' : 'tooltip'}
      aria-modal={confirmingItem || promptOpen ? 'true' : undefined}
      // In menu mode, cursor leaving the pill dismisses it — UNLESS
      // we're in the confirm step. The confirm panel demands an
      // explicit choice (Cancel button, Esc, outside-click), so
      // mouseleave is intentionally inert there: a stray cursor exit
      // shouldn't lose the in-progress confirmation.
      onMouseLeave={menuMode && !confirmingItem ? closeMenu : undefined}
    >
      {content}
    </div>,
    document.body,
  ) : null;

  return {
    handleMouseMove,
    handleMouseLeave,
    handleContextMenu,
    handleOpenPrompt,
    closeMenu,
    isMenuOpen: menuMode || promptOpen,
    node,
  };
}
