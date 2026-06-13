// mail.js — client wrapper for the `mail-sync` edge function (live Gmail /
// Outlook integration for the Mail tab). The renderer never sees OAuth tokens;
// everything goes through the function, which stores + refreshes them server-side.
//
// OAuth round-trip (mirrors the app's Supabase auth flow):
//   1. beginMailOAuth(provider) → mail-sync `authorize` builds the provider
//      consent URL (redirect_uri = the public `mail-callback` function) and we
//      open it in the OS browser (Electron) / full-page redirect (web).
//   2. The provider redirects to `mail-callback`, which hops the `code` back to
//      the app — `docvex://mail/callback?code=…` (Electron, surfaced by
//      AuthContext as a `docvex:mail-callback` window event) or
//      `…/mail?mailcode=…` (web, read from the URL on mount).
//   3. completeMailOAuth({ provider, code }) → mail-sync `connect` exchanges the
//      code for tokens and stores the connection.

import { supabase } from './supabaseClient';
import { isElectron, openOAuthUrl } from './platform';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

// The OAuth redirect_uri registered with Google / Microsoft. Must be identical
// in the authorize request AND the token exchange, so both flow through here.
export function mailCallbackUrl() {
  return `${SUPABASE_URL}/functions/v1/mail-callback`;
}

// The web /mail URL the callback bridge should hop back to (web only).
function webReturnUrl() {
  const base = import.meta.env.BASE_URL || '/';
  return `${window.location.origin}${base}mail`.replace(/([^:]\/)\/+/g, '$1');
}

function unwrap(data, error) {
  if (error) return { error };
  if (!data || data.ok === false) return { error: new Error(data?.error || 'mail_unavailable'), code: data?.error };
  return { data };
}

async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('mail-sync', { body });
  return unwrap(data, error);
}

// Connection status — { connected, provider, email } (never throws).
export async function getMailStatus() {
  const res = await invoke({ action: 'status' });
  if (res.error) return { connected: false, error: res.error };
  return { connected: !!res.data.connected, provider: res.data.provider, email: res.data.email };
}

// Kick off the OAuth consent flow for a provider. The server mints the CSRF
// nonce and embeds it (with the hop target) in the OAuth `state`. Returns { ok }
// once the browser has been sent to consent, or { error, code } if the provider
// isn't configured server-side.
export async function beginMailOAuth(provider) {
  const redirectUri = mailCallbackUrl();
  const target = isElectron ? 'electron' : encodeURIComponent(webReturnUrl());
  const res = await invoke({ action: 'authorize', provider, redirectUri, target });
  if (res.error) return res;
  try { sessionStorage.setItem('docvex.mail.pendingProvider', provider); } catch { /* ignore */ }
  openOAuthUrl(res.data.url);
  return { ok: true };
}

// Exchange the returned code for stored tokens (verifies the single-use CSRF
// nonce server-side). Returns { ok, email, provider } or { error, code }.
export async function completeMailOAuth({ provider, code, nonce }) {
  const res = await invoke({ action: 'connect', provider, code, nonce, redirectUri: mailCallbackUrl() });
  if (res.error) return res;
  return { ok: true, email: res.data.email, provider: res.data.provider };
}

// Fetch the live inbox — { messages: [...] } or { error }.
export async function listMail() {
  const res = await invoke({ action: 'list' });
  if (res.error) return res;
  return { messages: Array.isArray(res.data.messages) ? res.data.messages : [] };
}

// Send a reply. Returns { ok } or { error }.
export async function sendMail({ to, subject, body, threadId, inReplyTo, references }) {
  const res = await invoke({ action: 'send', to, subject, body, threadId, inReplyTo, references });
  if (res.error) return res;
  return { ok: true };
}

export async function disconnectMail() {
  const res = await invoke({ action: 'disconnect' });
  if (res.error) return res;
  return { ok: true };
}
