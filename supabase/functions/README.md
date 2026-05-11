# Supabase Edge Functions — invite flow

Three functions back the project-invitation flow. They are deployed directly
to the Supabase project (`pntxlvhkqfryyyxlqytr`) via MCP `deploy_edge_function`,
NOT through the `supabase` CLI. The source files in this directory are the
canonical implementation; redeploy after editing.

| Function        | Method | Auth                                  | Body                              | Returns                       |
| --------------- | ------ | ------------------------------------- | --------------------------------- | ----------------------------- |
| `send-invite`   | POST   | JWT + `has_project_role(_, 'admin')` | `{ project_id, email, role }`     | `{ ok, invitation_id }`       |
| `accept-invite` | POST   | JWT (caller email must match invite)  | `{ token }`                       | `{ ok, project_id }`          |
| `revoke-invite` | POST   | JWT + `has_project_role(_, 'admin')` | `{ invitation_id }`               | `{ ok }`                      |

All three:
- Require `Authorization: Bearer <user_jwt>` (auto-verified by Supabase).
- Handle `OPTIONS` for CORS preflight.
- Return JSON `{ error: <slug>, detail?: <string> }` with appropriate 4xx/5xx on failure.

## Secrets to set (Supabase Dashboard → Project Settings → Edge Functions → Secrets)

| Name                         | Purpose                                       | Required for     |
| ---------------------------- | --------------------------------------------- | ---------------- |
| `SUPABASE_URL`               | Auto-set by Supabase                          | all              |
| `SUPABASE_ANON_KEY`          | Auto-set by Supabase                          | all              |
| `SUPABASE_SERVICE_ROLE_KEY`  | Auto-set by Supabase                          | all              |
| `RESEND_API_KEY`             | Resend API key for outbound invite emails     | `send-invite`    |

`send-invite` will return `{ ok: true }` even if `RESEND_API_KEY` is unset or
Resend rejects (e.g. `docvex.app` not yet verified) — the invitation row is
already created, so an admin can copy the link from the Members page manually.
This is intentional: the *invitation* succeeded; the *email delivery* is a
best-effort side channel.

## Smoke tests — curl

Set these once per shell (PowerShell syntax shown — for bash, drop the `$` on
the right side of `=`):

```powershell
$SUPABASE_URL = "https://pntxlvhkqfryyyxlqytr.supabase.co"
$SUPABASE_ANON_KEY = "<your VITE_SUPABASE_ANON_KEY from .env>"
# Get a real user JWT: sign in via the app and pull from DevTools →
# Application → Local Storage → sb-<project>-auth-token → access_token
$USER_JWT = "<paste here>"
$PROJECT_ID = "<a project uuid you're admin on>"
```

### 1. CORS preflight (should return 200 with the CORS headers)

```powershell
curl -i -X OPTIONS "$SUPABASE_URL/functions/v1/send-invite" `
  -H "Origin: http://localhost"
```

Expected: `HTTP/2 200`, `access-control-allow-origin: *`, body `ok`.

### 2. send-invite — happy path (admin invites a new email)

```powershell
curl -s -X POST "$SUPABASE_URL/functions/v1/send-invite" `
  -H "Authorization: Bearer $USER_JWT" `
  -H "apikey: $SUPABASE_ANON_KEY" `
  -H "Content-Type: application/json" `
  -d "{\"project_id\": \"$PROJECT_ID\", \"email\": \"teammate@example.com\", \"role\": \"member\"}"
```

Expected: `{"ok":true,"invitation_id":"<uuid>"}`.
Check the row: `select id, email, role, token, expires_at from public.project_invitations where project_id = '<PROJECT_ID>';`

### 3. send-invite — forbidden (caller isn't admin on that project)

Use a JWT for a user who isn't in the project (or is only `member`/`viewer`):

```powershell
curl -s -X POST "$SUPABASE_URL/functions/v1/send-invite" `
```

Expected: HTTP 403, body `{"error":"forbidden"}`.

### 4. accept-invite — happy path

The invitee (whose email matches `teammate@example.com` in the example above)
signs in, gets *their* JWT, then:

```powershell
$INVITE_TOKEN = "<token column from the invitation row>"
curl -s -X POST "$SUPABASE_URL/functions/v1/accept-invite" `
  -H "Authorization: Bearer $INVITEE_JWT" `
  -H "apikey: $SUPABASE_ANON_KEY" `
  -H "Content-Type: application/json" `
  -d "{\"token\": \"$INVITE_TOKEN\"}"
```

Expected: `{"ok":true,"project_id":"<uuid>"}`. Verify in DB:
- `select * from public.project_members where project_id = '<PROJECT_ID>' and user_id = '<invitee uuid>';` → new row.
- `select accepted_at from public.project_invitations where token = '<token>';` → not null.

### 5. accept-invite — email mismatch

Sign in as a different user (whose email ISN'T the one invited) and call with
the same token. Expected: HTTP 403, body `{"error":"email_mismatch"}`.

### 6. accept-invite — already accepted (replay)

Call accept-invite a second time with the same token. Expected: HTTP 409, body `{"error":"already_accepted"}`.

### 7. revoke-invite — happy path

Admin again (different JWT than the invitee). Use the `invitation_id` from a
*pending* invite (i.e. another `send-invite` first):

```powershell
curl -s -X POST "$SUPABASE_URL/functions/v1/revoke-invite" `
  -H "Authorization: Bearer $USER_JWT" `
  -H "apikey: $SUPABASE_ANON_KEY" `
  -H "Content-Type: application/json" `
  -d "{\"invitation_id\": \"<uuid>\"}"
```

Expected: `{"ok":true}`. Verify the row is gone:
`select * from public.project_invitations where id = '<uuid>';` → 0 rows.

### 8. revoke-invite — forbidden

Same call but with a non-admin's JWT. Expected: HTTP 403, body `{"error":"forbidden"}`.

## Common pitfalls

- **No `apikey` header** → Supabase's gateway 401s before your function code runs. The `apikey` is `SUPABASE_ANON_KEY` (not the user's JWT).
- **`Authorization: Bearer <SUPABASE_ANON_KEY>`** → JWT verification fails (the anon key isn't a user JWT). Use a real user JWT.
- **Expired JWT** → 401 with `{"code":"PGRST301","message":"JWT expired"}`. Sign back in.
- **`docvex.ro` not verified in Resend** → `send-invite` logs `[send-invite] resend rejected 403 …` but still returns 200. The invite is real; only the email delivery is missing. Verify the domain in the Resend dashboard.
