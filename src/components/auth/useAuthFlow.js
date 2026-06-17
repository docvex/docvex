import { useCallback, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';

// Mirrors the design's auth state machine (mode: signin/signup, a 3-step
// onboarding wizard, fields, validation) but wired to the real Supabase
// auth surface. One instance is shared across whichever of the three visual
// variations is active, so switching the look never resets a half-typed form.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 0 empty · 1 too short · 2 ok · 3 strong (letters+digits, 12+ chars).
export function passwordStrength(pw) {
  pw = pw || '';
  if (pw.length === 0) return 0;
  if (pw.length < 8) return 1;
  if (/[0-9]/.test(pw) && /[A-Za-z]/.test(pw) && pw.length >= 12) return 3;
  return 2;
}
export const STRENGTH_LABELS = ['Use 8+ characters', 'Weak', 'Good', 'Strong'];

export function useAuthFlow(initial = {}) {
  const { signInWithEmail, signUpWithEmail, signInWithGoogle } = useAuth();

  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [step, setStep] = useState(0);         // 0 account · 1 profile · 2 confirm
  const [email, setEmail] = useState(initial.email || '');
  const [password, setPassword] = useState(initial.password || '');
  const [name, setName] = useState('');
  const [firm, setFirm] = useState('');
  const [agree, setAgree] = useState(false);
  const [news, setNews] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');    // non-error info (reset link sent)
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // When a signup succeeds but Supabase returns no session, email
  // confirmation is required — holds the address we sent the link to.
  const [confirmEmail, setConfirmEmail] = useState('');

  const toSignup = useCallback(() => {
    setMode('signup'); setStep(0); setError(''); setNotice(''); setDone(false); setConfirmEmail('');
  }, []);
  const toSignin = useCallback(() => {
    setMode('signin'); setStep(0); setError(''); setNotice(''); setDone(false); setConfirmEmail('');
  }, []);

  const reset = useCallback(() => {
    setMode('signin'); setStep(0); setEmail(''); setPassword(''); setName('');
    setFirm(''); setAgree(false); setNews(true); setError(''); setNotice('');
    setDone(false); setConfirmEmail('');
  }, []);

  // Field setters clear any stale error the moment the user edits.
  const bind = useCallback((setter) => (e) => {
    setter(e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e);
    setError('');
  }, []);

  const next = useCallback(() => {
    if (step === 0) {
      if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email address.');
      if ((password || '').length < 8) return setError('Password must be at least 8 characters.');
    } else if (step === 1) {
      if (!name.trim()) return setError('Please enter your full name.');
      if (!firm.trim()) return setError('Please enter your firm or organization.');
    }
    setError('');
    setStep((s) => Math.min(2, s + 1));
  }, [step, email, password, name, firm]);

  const back = useCallback(() => {
    setError('');
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const doSignin = useCallback(async () => {
    if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email address.');
    if ((password || '').length < 1) return setError('Please enter your password.');
    setError(''); setNotice(''); setBusy(true);
    try {
      const { error: err } = await signInWithEmail(email.trim(), password);
      if (err) throw err;
      // Success → AuthContext emits SIGNED_IN and AuthPage's <Navigate> unmounts us.
    } catch (err) {
      setError(err.message || 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }, [email, password, signInWithEmail]);

  const finish = useCallback(async () => {
    if (!agree) return setError('Please accept the Terms and Privacy Policy to continue.');
    setError(''); setBusy(true);
    try {
      const { data, error: err } = await signUpWithEmail(email.trim(), password, {
        full_name: name.trim(),
        firm: firm.trim(),
        newsletter_opt_in: !!news,
      });
      if (err) throw err;
      setDone(true);
      // No session → the project's Supabase has "confirm email" enabled.
      if (!data?.session) setConfirmEmail(email.trim());
    } catch (err) {
      setError(err.message || 'Could not create your account.');
    } finally {
      setBusy(false);
    }
  }, [agree, email, password, name, firm, news, signUpWithEmail]);

  const google = useCallback(async () => {
    setError(''); setNotice('');
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err.message || 'Google sign-in failed.');
    }
  }, [signInWithGoogle]);

  const forgot = useCallback(async () => {
    if (!EMAIL_RE.test(email.trim())) {
      return setError('Enter your email above first, then tap Forgot.');
    }
    setError(''); setNotice('');
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim());
    if (err) setError(err.message);
    else setNotice('Password reset link sent — check your email.');
  }, [email]);

  const firstName = (name.trim().split(/\s+/)[0]) || 'there';

  return {
    // state
    mode, step, email, password, name, firm, agree, news,
    error, notice, busy, done, confirmEmail, firstName,
    strength: passwordStrength(password),
    strengthLabel: STRENGTH_LABELS[passwordStrength(password)],
    // field setters (clear error on edit)
    onEmail: bind(setEmail),
    onPassword: bind(setPassword),
    onName: bind(setName),
    onFirm: bind(setFirm),
    onAgree: bind(setAgree),
    onNews: bind(setNews),
    // actions
    toSignup, toSignin, next, back, doSignin, finish, google, forgot, reset,
  };
}
