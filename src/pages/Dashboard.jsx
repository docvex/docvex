import React from 'react';
import { useAuth } from '../context/AuthContext';

// Inline styles intentionally — this is a 2-rule page; a sibling .css file
// would be overkill. The color refs use CSS custom properties via `var(...)`
// so they pick up the active theme like every per-component stylesheet does.
const titleStyle = {
  margin: '0 0 0.5rem',
  fontSize: '1.5rem',
  fontWeight: 600,
  color: 'var(--text-primary)',
};
const subtitleStyle = {
  color: 'var(--text-muted)',
  fontSize: '0.9rem',
  margin: 0,
};

export default function Dashboard() {
  const { session } = useAuth();

  return (
    <div>
      <h1 style={titleStyle}>Activity</h1>
      <p style={subtitleStyle}>Signed in as {session?.user?.email}</p>
    </div>
  );
}
