import React from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import UpdateProgressBar from './UpdateProgressBar';
import './AppShell.css';

export default function AppShell() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        <Outlet />
      </main>
      {/* Fixed-bottom indeterminate progress strip; renders only while an
          update is checking/downloading. Lives at the shell level so the
          user keeps the feedback even after navigating away from /updates. */}
      <UpdateProgressBar />
    </div>
  );
}
