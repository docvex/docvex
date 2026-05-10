import React from 'react';
import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const { session } = useAuth();

  return (
    <div>
      <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.5rem', fontWeight: 600, color: '#e0e0e0' }}>
        Dashboard
      </h1>
      <p style={{ color: '#666', fontSize: '0.9rem', margin: 0 }}>
        Signed in as {session?.user?.email}
      </p>
    </div>
  );
}
