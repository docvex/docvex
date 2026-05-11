import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUpdates } from '../context/UpdatesContext';
import { useNotifications } from '../context/NotificationsContext';
import { PLAN } from '../lib/plan';
import './Sidebar.css';

function getDisplayName(user) {
  return (
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email ||
    'Account'
  );
}

const DashboardIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7"/>
    <rect x="14" y="3" width="7" height="7"/>
    <rect x="3" y="14" width="7" height="7"/>
    <rect x="14" y="14" width="7" height="7"/>
  </svg>
);

const BellIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>
);

const SignInIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
    <polyline points="10 17 15 12 10 7"/>
    <line x1="15" y1="12" x2="3" y2="12"/>
  </svg>
);

const LockOpenIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
  </svg>
);

const LockClosedIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);

const LOCK_STORAGE_KEY = 'docvex.sidebarLocked';

function AccountAvatar({ user }) {
  // Mirrors the Account page's avatar logic: real picture for OAuth users,
  // initial-letter fallback for email-only sign-ups.
  const avatarUrl = user?.user_metadata?.avatar_url;
  const initial = (user?.email || '?').charAt(0).toUpperCase();

  if (avatarUrl) {
    return (
      <img
        className="sidebar-avatar"
        src={avatarUrl}
        alt=""
        referrerPolicy="no-referrer"
      />
    );
  }
  return <span className="sidebar-avatar sidebar-avatar-fallback">{initial}</span>;
}

export default function Sidebar() {
  const { session } = useAuth();
  const { hasUpdate, currentVersion } = useUpdates();
  const { unreadCount } = useNotifications();
  // Persist the lock preference so the layout doesn't snap closed on every reload
  const [locked, setLocked] = useState(() => {
    try { return localStorage.getItem(LOCK_STORAGE_KEY) === 'true'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(LOCK_STORAGE_KEY, String(locked)); } catch { /* ignore */ }
  }, [locked]);

  // Build the nav list. Notifications is signed-in-only; we filter out items
  // whose `visible` predicate returns false so the sidebar is uncluttered
  // when no session exists. The Updates page is reachable via the version
  // link in the brand row, so it doesn't need its own nav tab.
  const navItems = [
    { to: '/', label: 'Dashboard', icon: DashboardIcon, end: true },
    {
      to: '/notifications',
      label: 'Notifications',
      icon: BellIcon,
      end: true,
      visible: !!session,
      badge: unreadCount > 0 ? (unreadCount > 9 ? '9+' : String(unreadCount)) : null,
    },
  ].filter((item) => item.visible !== false);

  return (
    <nav className={`sidebar${locked ? ' locked' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-left">
          <span className="icon brand-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" strokeWidth="2"/>
            </svg>
          </span>
          <span className="label brand-text">
            <span className="brand-name">DOCVEX</span>
            {currentVersion && (
              <NavLink
                to="/updates"
                end
                className="brand-version"
                title={hasUpdate ? 'Update available — open Updates' : 'Open Updates'}
              >
                <span className="brand-version-num">v{currentVersion}</span>
                {hasUpdate && (
                  <span className="brand-version-badge">Update available</span>
                )}
              </NavLink>
            )}
          </span>
        </div>
        <button
          type="button"
          className={`label lock-btn${locked ? ' is-locked' : ''}`}
          onClick={() => setLocked((v) => !v)}
          title={locked ? 'Unlock sidebar' : 'Lock sidebar open'}
          aria-label={locked ? 'Unlock sidebar' : 'Lock sidebar open'}
          aria-pressed={locked}
        >
          {locked ? LockClosedIcon : LockOpenIcon}
        </button>
      </div>

      <ul className="sidebar-nav">
        {navItems.map(({ to, label, icon, end, badge }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="icon">
                {icon}
                {badge && <span className="nav-badge" aria-hidden="true" />}
              </span>
              <span className="label nav-label-row">
                {label}
                {badge && <span className="nav-badge-text">{badge}</span>}
              </span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        {session ? (() => {
          const displayName = getDisplayName(session.user);
          return (
            <NavLink
              to="/account"
              end
              className={({ isActive }) => `nav-item account-btn${isActive ? ' active' : ''}`}
              title={`${displayName} · ${PLAN.tier}`}
            >
              <span className="icon">
                <AccountAvatar user={session.user} />
              </span>
              <span className="label account-btn-label">
                <span className="account-btn-name">{displayName}</span>
                <span className="account-btn-tier">{PLAN.tier}</span>
              </span>
            </NavLink>
          );
        })() : (
          <NavLink to="/auth" className="nav-item signin-btn">
            <span className="icon">{SignInIcon}</span>
            <span className="label">Sign in</span>
          </NavLink>
        )}
      </div>
    </nav>
  );
}
