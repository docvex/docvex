# Mail tab — live Gmail / Outlook setup

The Mail tab (`/mail`, next to Debug) connects a **real** mailbox and drafts AI
replies. The code is fully wired; to make it work end-to-end you must finish the
OAuth app configuration in Google / Microsoft and set the secrets below. Until
then the connect screen shows a friendly "isn't configured yet" message.

## How it fits together

```
renderer (src/pages/Mail.jsx, src/lib/mail.js)
  → mail-sync edge function   (authorize / connect / status / list / send / disconnect)
       → Gmail REST API  /  Microsoft Graph
  → mail-callback edge function (public OAuth redirect bridge: https → docvex://)
tokens stored in public.user_mail_connections (RLS server-only; never sent to the client)
```

The **single OAuth redirect URI** you register with both providers is the
public bridge function:

```
https://pntxlvhkqfryyyxlqytr.supabase.co/functions/v1/mail-callback
```

Google/Microsoft can't redirect to a `docvex://` custom scheme directly, so the
bridge receives the `code` over https and hops it to the app
(`docvex://mail/callback?...` on Electron, `…/mail?mailcode=…` on web) — the same
pattern the app already uses for Supabase Google sign-in.

## 1. Supabase Edge Function secrets

Dashboard → Edge Functions → Secrets (or `supabase secrets set`):

| Secret | For |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Outlook / Microsoft 365 |
| `MAIL_TOKEN_KEY` | **Required for production.** Encrypts the stored OAuth tokens at rest. Generate with `openssl rand -base64 32` and set it once. Keep it secret and back it up — rotating it invalidates all stored connections (users just reconnect). If unset, tokens are stored unencrypted (dev only). |

`ANTHROPIC_API_KEY` is already required by `project-ai` and powers the AI
drafting here too — no new AI secret needed.

### Security model (what was hardened for production)

- **Tokens encrypted at rest** with AES-256-GCM using `MAIL_TOKEN_KEY`, which
  lives in the function env — *not* the database. A DB dump or leaked
  service-role key alone cannot read anyone's mailbox.
- **CSRF protection:** `authorize` mints a single-use, user-bound nonce
  (`public.mail_oauth_states`, server-only RLS) carried in the OAuth `state`;
  `connect` verifies + consumes it, so a returned code can only complete a
  connection for the user who actually started the flow.
- **Revoked/expired grants** (`invalid_grant`) drop the stored connection and
  return `reauth_required`; the UI falls back to the connect screen.
- **Disconnect** revokes the Google token at Google before deleting the row;
  account deletion cascades the row away via the `user_id` FK.

(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected
automatically.)

## 2. Google (Gmail)

1. Google Cloud Console → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen**: User type **External**. Add scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - (plus `openid`, `email`, `profile`)
3. **Credentials → Create OAuth client ID → Web application**. Add the
   **Authorized redirect URI**:
   `https://pntxlvhkqfryyyxlqytr.supabase.co/functions/v1/mail-callback`
4. Copy the client ID + secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

> ⚠️ `gmail.readonly` and `gmail.send` are **restricted scopes**. In *Testing*
> mode they work for accounts you add as test users. For production (any Google
> user) Google requires an OAuth verification + a CASA security assessment.
> Reuse your existing Google project (the one already used for Supabase Google
> sign-in) so you only verify once.

## 3. Microsoft (Outlook / Microsoft 365)

1. Entra admin center (Azure AD) → **App registrations → New registration**.
   Supported account types: "Accounts in any org directory and personal
   Microsoft accounts" (for both work and @outlook.com).
2. **Authentication → Add a platform → Web**, redirect URI:
   `https://pntxlvhkqfryyyxlqytr.supabase.co/functions/v1/mail-callback`
3. **API permissions → Microsoft Graph → Delegated**: `Mail.Read`, `Mail.Send`,
   `User.Read`, `offline_access`.
4. **Certificates & secrets → New client secret**.
5. Copy Application (client) ID + secret into `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.

## 4. Custom scheme (already handled)

The app already registers the `docvex://` protocol (used for Google sign-in).
The bridge redirects to `docvex://mail/callback`, which `src/main.js` forwards to
the renderer; `AuthContext` re-broadcasts it as a `docvex:mail-callback` window
event that `Mail.jsx` consumes. No extra OS/registry work is required.

## What works once configured

- Connect Gmail / Outlook from the connect screen (real consent flow).
- The live inbox (most recent ~12 messages) loads from the provider.
- Each message gets an AI-drafted reply (tone + length controls, reasoning,
  inline edit, Regenerate).
- **Send reply** sends through the provider (Gmail threads via `threadId`).
- Disconnect deletes the stored tokens.

## Production checklist

- [ ] `GOOGLE_CLIENT_ID/SECRET`, `MS_CLIENT_ID/SECRET`, **`MAIL_TOKEN_KEY`** set.
- [ ] Redirect URI registered in Google Cloud Console + Microsoft Entra.
- [ ] Public homepage + privacy policy meeting Google's Limited Use policy.
- [ ] Google OAuth app published + **verified**, and (for consumer @gmail.com
      users) the **CASA Tier 2** security assessment completed — OR, for B2B,
      each customer's Workspace admin allowlists the OAuth client (no CASA).
- [ ] Microsoft publisher verification (for multi-tenant).

## Known limitations / next steps

- IMAP/other is intentionally disabled (no OAuth) — would need an IMAP/SMTP
  client + app-password storage.
- "Archive" is a local dismiss; it doesn't move the message in the mailbox yet.
- Drafts are generated per message on load (one Claude call each) — fine for ~12
  messages; add lazy/on-demand drafting if you raise the fetch cap.
