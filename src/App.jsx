import React from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import AuthPage from './components/AuthPage';
import AppShell from './components/AppShell';
import Dashboard from './pages/Dashboard';
import Account from './pages/Account';
import Updates from './pages/Updates';
import Notifications from './pages/Notifications';

function ProtectedRoute() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div className="spinner" />
      </div>
    );
  }

  return session ? <Outlet /> : <Navigate to="/auth" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/" element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="updates" element={<Updates />} />
        <Route path="notifications" element={<Notifications />} />
        <Route element={<ProtectedRoute />}>
          <Route path="account" element={<Account />} />
        </Route>
      </Route>
    </Routes>
  );
}
