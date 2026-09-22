// The account's hover card + menu — ONE implementation, used by the Sidebar's
// account row (main window) and the Doc Viewer's avatar in the title bar.
//
// Hover: a card (a useMorphPill tooltip) with the account — name, email, plan —
// and, with a project selected, its AI usage this month. Click: the card
// morphs into a menu — Account settings, Log out (which asks first, inside the
// same pill). What those two DO is the caller's: the main window navigates and
// signs out itself; a Doc Viewer window hands both to the main window.
import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useSelectedProject } from '../context/SelectedProjectContext';
import { useMorphPill } from './useMorphPill';
import { useAiUsage, AiUsageBar, fmtTokens } from './AiUsageMeter';
import { accountIdentity } from '../lib/account';
import { PLAN } from '../lib/plan';
import './AccountMenu.css';

export function useAccountMenu({ onSettings, onLogout, loggingOut = false, placement = 'right' }) {
  const { session } = useAuth();
  const { selectedProjectId, selectedProject } = useSelectedProject();
  const identity = accountIdentity(session);
  const aiUsage = useAiUsage(session ? selectedProjectId : null);

  const card = (
    <span className="acm-card">
      <span className="acm-name">{identity.name}</span>
      {identity.email && <span className="acm-email">{identity.email}</span>}
      <span className="acm-plan">{PLAN.tier} plan</span>
      {selectedProjectId && (
        <>
          <span className="acm-rule" aria-hidden="true" />
          <span className="acm-row">
            <span className="acm-label">AI usage this month</span>
            <span className="acm-value" style={{ color: aiUsage.tint }}>{Math.round(aiUsage.pct)}%</span>
          </span>
          <AiUsageBar usage={aiUsage} className="acm-bar" />
          <span className="acm-sub">
            {fmtTokens(aiUsage.tokens)} of {fmtTokens(aiUsage.cap)} tokens
            {aiUsage.loaded ? ` · ${aiUsage.requests} ${aiUsage.requests === 1 ? 'request' : 'requests'}` : ''}
          </span>
          <span className="acm-sub">
            {selectedProject?.name ? `${selectedProject.name} · ` : ''}whole team · resets on the 1st
          </span>
        </>
      )}
    </span>
  );

  const pill = useMorphPill({
    hoverContent: card,
    className: 'acm-pill',
    placement,
    menuItems: [
      { key: 'settings', label: 'Account settings', onClick: onSettings },
      {
        key: 'logout',
        label: loggingOut ? 'Logging out…' : 'Log out',
        danger: true,
        disabled: loggingOut,
        onClick: onLogout,
        confirm: {
          title: 'Log out of DocVex?',
          message: 'You’ll be taken to the sign-in screen. Your files stay on this computer — signing back in picks up where you left off.',
          confirmLabel: 'Log out',
          cancelLabel: 'Stay signed in',
        },
      },
    ],
  });

  return { identity, aiUsage, selectedProjectId, pill };
}
