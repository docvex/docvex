import React, { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import CursorSpotlight from './CursorSpotlight';
import bigLogo from '../big_logo.png';
import './AuthPage.css';

// One-shot read of the prefill credentials written by AuthContext when the
// user triggered the "Switch to <email>" menu item. Done eagerly during
// the initial render (via useState's init fn) so we never miss them; the
// storage keys are cleared immediately so a manual reload or a sign-out-
// and-back-in doesn't replay stale values. `password` is null when the
// menu item only carried an email.
function consumePrefillCreds() {
  try {
    const email = sessionStorage.getItem('docvex.prefillEmail') || '';
    const password = sessionStorage.getItem('docvex.prefillPassword') || '';
    if (email) sessionStorage.removeItem('docvex.prefillEmail');
    if (password) sessionStorage.removeItem('docvex.prefillPassword');
    return { email, password };
  } catch {
    return { email: '', password: '' };
  }
}

// ── Inline icons (app convention — no icon library; currentColor-driven). ──
const MailIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
  </svg>
);
const LockIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const EyeIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOffIcon = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M9.9 5.2A9.5 9.5 0 0 1 12 5c7 0 10.5 7 10.5 7a16 16 0 0 1-3.3 4.1M6.5 6.6A16 16 0 0 0 1.5 12S5 19 12 19a9.4 9.4 0 0 0 4-.9" />
    <path d="m9.9 9.9a3 3 0 0 0 4.2 4.2" /><line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);

// Top-3 features shown on the brand panel — an icon over a short label, mirroring
// the reference's "Modern Design / Responsive Layout / Secure Access" row.
const FEATURES = [
  {
    key: 'ai',
    label: 'Legal AI',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l1.8 4.9L18.8 9 13.8 10.8 12 15.7 10.2 10.8 5.2 9l5-1.1z" />
        <path d="M18.5 14.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" />
      </svg>
    ),
  },
  {
    key: 'team',
    label: 'Team Spaces',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
        <path d="M16 5.2a3 3 0 0 1 0 5.6" />
        <path d="M17 14.3A5.5 5.5 0 0 1 20.5 20" />
      </svg>
    ),
  },
  {
    key: 'secure',
    label: 'Secure Access',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  {
    key: 'docs',
    label: 'Documents',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M9 13h6M9 17h6" />
      </svg>
    ),
  },
  {
    key: 'mail',
    label: 'Smart Mail',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    ),
  },
  {
    key: 'news',
    label: 'Legal News',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 22h14a2 2 0 0 0 2-2V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v16a2 2 0 0 1-2-2V8" />
        <path d="M8 7h6M8 11h6M8 15h4" />
      </svg>
    ),
  },
];

export default function AuthPage() {
  const { session, signInWithEmail, signUpWithEmail, signInWithGoogle } = useAuth();
  // useState's init fn runs once on mount, so the storage read + clear
  // happens in the same tick the page first renders.
  const [prefilled] = useState(consumePrefillCreds);
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState(prefilled.email);
  const [password, setPassword] = useState(prefilled.password);
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // When the password came from the prefill we render it as type="text" so
  // the dev can see what's about to be submitted (until they edit it). The eye
  // toggle ORs into this so the user can also reveal what they typed.
  const showPasswordPlain = !!prefilled.password && password === prefilled.password;
  const passwordVisible = showPassword || showPasswordPlain;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setIsLoading(true);

    try {
      if (mode === 'signin') {
        const { error } = await signInWithEmail(email, password);
        if (error) throw error;
      } else {
        const { error } = await signUpWithEmail(email, password);
        if (error) throw error;
        setMessage('Check your email to confirm your account.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogle = async () => {
    setError('');
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err.message);
    }
  };

  // Forgot password — emails a reset link via Supabase. Needs an email first.
  const handleForgot = async () => {
    setError('');
    setMessage('');
    if (!email) {
      setError('Enter your email above first, then tap Forgot password.');
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) setError(error.message);
    else setMessage('Password reset link sent — check your email.');
  };

  // Once AuthContext has a session (email sign-in resolves, or OAuth callback
  // completes exchangeCodeForSession), bounce out of /auth into the app.
  if (session) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="auth-page">
      {/* Ambient dot grid (auth-page::before) + this cursor-following spotlight —
          the same backdrop the main app shell paints. */}
      <CursorSpotlight />
      <div className="auth-split">
        {/* Left — brand panel: logo, description, divider, top-3 features. */}
        <section className="auth-brand">
          <div className="auth-brand-inner">
            <img className="auth-logo" src={bigLogo} alt="DocVex — Intelligent Legal Workflows" />
            <p className="auth-tagline">
              Crafting intelligent legal workflows — your documents, your team,
              and AI that drafts, reviews and researches, in one secure place.
            </p>
            <div className="auth-brand-divider" aria-hidden="true" />
            <ul className="auth-features">
              {FEATURES.map((f) => (
                <li key={f.key} className="auth-feature">
                  <span className="auth-feature-icon">{f.icon}</span>
                  <span className="auth-feature-label">{f.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Right — sign-in / sign-up card. */}
        <section className="auth-form-side">
          <div className="auth-card">
            <h1 className="auth-welcome">
              {mode === 'signin' ? 'Welcome' : 'Create your account'}
            </h1>
            <p className="auth-welcome-sub">
              {mode === 'signin'
                ? 'Enter your credentials to continue'
                : 'Get started with DocVex'}
            </p>

            <form onSubmit={handleSubmit} className="auth-form">
              <div className="form-group">
                <label htmlFor="email">Email</label>
                <div className="auth-input-wrap">
                  <MailIcon className="auth-input-icon" width="18" height="18" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoFocus={!email}
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="password">Password</label>
                <div className="auth-input-wrap">
                  <LockIcon className="auth-input-icon" width="18" height="18" />
                  <input
                    id="password"
                    type={passwordVisible ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoFocus={!!email}
                  />
                  <button
                    type="button"
                    className="auth-eye"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                    aria-pressed={passwordVisible}
                  >
                    {passwordVisible ? <EyeOffIcon width="18" height="18" /> : <EyeIcon width="18" height="18" />}
                  </button>
                </div>
              </div>

              {error && <p className="auth-error">{error}</p>}
              {message && <p className="auth-message">{message}</p>}

              {mode === 'signin' && (
                <div className="auth-row-between">
                  <label className="auth-remember">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                    />
                    <span>Remember me</span>
                  </label>
                  <button type="button" className="auth-forgot" onClick={handleForgot}>
                    Forgot password?
                  </button>
                </div>
              )}

              <button type="submit" className="btn-primary" disabled={isLoading}>
                {isLoading ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            <div className="auth-divider"><span>or login with</span></div>

            <button className="btn-google" onClick={handleGoogle} disabled={isLoading}>
              <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
              </svg>
              Google
            </button>

            <p className="auth-toggle">
              {mode === 'signin' ? "Don't have an account? " : 'Already have an account? '}
              <button
                type="button"
                className="link-btn"
                onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); setMessage(''); }}
              >
                {mode === 'signin' ? 'Sign up' : 'Sign in'}
              </button>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
