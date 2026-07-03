# Security follow-ups

Outstanding items from the deep security audit (2026-07). The rest of the audit
findings are already fixed in code / deployed — see the "Done" section at the
bottom for reference. Work the **Outstanding** list top to bottom.

---

## ⏸ Outstanding

### 1. Apply RLS migration `032` to production  — HIGH
- **File (ready):** [`supabase/migrations/032_rls_security_fixes.sql`](supabase/migrations/032_rls_security_fixes.sql)
- **Why:** fixes the owner-takeover (any admin can permanently demote/lock out the
  project owner), self-privilege-escalation (a viewer-tier custom role with
  `members.change_role` can promote itself to admin), and cross-project chat /
  private-message injection. All three were verified live against the DB.
- **What it does:** 3 `ALTER POLICY` statements (reversible), only tightens.
- **How:** apply via Supabase MCP `apply_migration` (or `supabase db push`), then
  re-query `pg_policies` to confirm.
- **⚠️ Caveats before applying:**
  - After this, there is **no RLS path to transfer ownership** (setting
    `role='owner'` is forbidden). If ownership transfer is ever needed, add a
    `SECURITY DEFINER transfer_ownership(project_id, new_owner)` RPC.
  - `user_id <> auth.uid()` blocks any self-update of one's own membership row
    (intended — role changes to self aren't a feature).

### 2. macOS self-updater: stop trusting the renderer-supplied URL  — HIGH
- **File:** [`src/main.js`](src/main.js) — `update:download-and-install` handler
  (`downloadAndInstallUpdate`), around the `downloadToFile` / `ditto` / `codesign`
  chain; and [`src/context/UpdatesContext.jsx`](src/context/UpdatesContext.jsx)
  (`installerAssetFor`).
- **Why:** the handler downloads any HTTPS URL the renderer passes, ad-hoc-signs it
  (which authenticates nothing), swaps `/Applications/DocVex.app`, and relaunches.
  A renderer foothold → persistent native code execution (XSS → RCE).
- **Fix:**
  - Ignore the URL from the renderer; re-resolve the release asset in the main
    process against a **pinned** `github.com` / `objects.githubusercontent.com`
    host, and reject redirects to other hosts (`redirect: 'error'` + host check).
  - Add a real integrity check: verify the downloaded zip against a committed
    SHA-256 / detached signature **before** `ditto`/`codesign`.
- **Note:** touches the release path — test an actual packaged macOS update.

### 3. Rotate the leaked dev-account password  — do this regardless of code
- The password was committed in `src/main.js` (now removed from source, but it's
  in **git history** = effectively public). Change that Supabase account's
  password. Consider the old one burned.
- Optional: purge it from git history (filter-repo/BFG) if the repo is/was shared.

### 4. Web build CSP  — MEDIUM (defense-in-depth)
- **File:** `index.web.html`
- The Electron build already gets a strict CSP via response headers (packaged
  only). The web build (`docvex.ro/app`) has none.
- **Fix:** add a `<meta http-equiv="Content-Security-Policy">` to `index.web.html`
  (script-src 'self'; object-src 'none'; base-uri 'none'; connect-src limited to
  self + `*.supabase.co` + GitHub; img/media/font as needed). Test the deployed
  web app before shipping — a too-strict CSP can break it.

### 5. (Optional hardening) constrain capability grants per base tier
- **File:** `create_custom_role` / `update_custom_role` RPCs (see
  `supabase/migrations/008_custom_roles_and_capabilities.sql`).
- Prevent `members.change_role` / `members.remove` / `members.invite` from being
  attached to a **viewer/member** base custom role (enforce server-side, not just
  in the Roles matrix UI), so an admin can't accidentally hand a low-trust role an
  escalation primitive. Complements migration 032.

---

## ✅ Done (for reference — no action needed)

Fixed in code (live on next build) and via edge deploys:
- `localfile://` arbitrary-file read → realpath root allow-list (`src/main.js`)
- Zip symlink extraction → `stripSymlinks()` on all extractions (`src/main.js`)
- WhatsApp attachment path traversal → name sanitized (`src/pages/DocViewer.jsx`)
- `oauth:open-external` unfiltered → unified http(s)/docvex-only guard (`src/main.js`)
- SSRF via `local-folder:download` → `*.supabase.co` allowlist (`src/main.js`)
- Missing navigation guard → `will-navigate` + `setWindowOpenHandler` (`src/main.js`)
- No CSP (Electron) → strict CSP response header on packaged builds (`src/main.js`)
- Hardcoded password → removed from source, reads `DOCVEX_DEV_PASSWORD` env (`src/main.js`)
- Email header (CRLF) injection → stripped in Gmail send (`mail-sync`, deployed v11)
- OAuth open redirect (earlier) → origin allowlist (`mail-callback`, deployed v9)
