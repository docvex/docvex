import React from 'react';
import { useBranch } from '../context/BranchContext';
import Tooltip from './Tooltip';
import './BranchToggle.css';

// Segmented "Main / My branch" switch sitting in the Files page header.
//
// • Main is always shown — viewers / non-members have nowhere else to go.
// • "My branch" is shown only to members (admins included). It carries a
//   pending-count badge so the user knows whether they have uncommitted
//   work without having to switch to it.
// • A "behind main" dot appears next to "Main" when the member's
//   base_version is below the project's main_version — they have stale
//   files locally and should sync.

const BranchIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

const TrunkIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="12" cy="19" r="2.5" />
    <line x1="12" y1="7.5" x2="12" y2="16.5" />
  </svg>
);

export default function BranchToggle() {
  const { view, setView, pendingChanges, isBehindMain, isMember } = useBranch();
  const pendingCount = pendingChanges.length;

  return (
    <div className="branch-toggle" role="tablist" aria-label="Branch view">
      <Tooltip content={isBehindMain ? 'Main has new changes — sync to update' : 'View the canonical project files'}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'main'}
          className={`branch-toggle-btn${view === 'main' ? ' is-active' : ''}`}
          onClick={() => setView('main')}
        >
          {TrunkIcon}
          <span>Main</span>
          {isBehindMain && <span className="branch-toggle-dot" aria-label="behind main" />}
        </button>
      </Tooltip>
      {isMember && (
        <Tooltip content="Your private working copy — edits here are queued for an admin to approve">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'mine'}
            className={`branch-toggle-btn${view === 'mine' ? ' is-active' : ''}`}
            onClick={() => setView('mine')}
          >
            {BranchIcon}
            <span>My branch</span>
            {pendingCount > 0 && (
              <span className="branch-toggle-count" aria-label={`${pendingCount} pending change${pendingCount === 1 ? '' : 's'}`}>
                {pendingCount}
              </span>
            )}
          </button>
        </Tooltip>
      )}
    </div>
  );
}
