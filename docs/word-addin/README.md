# DocVex Legal AI — Word add-in

A Microsoft Word taskpane add-in that puts DocVex's Claude-powered legal
assistant next to the document you're editing. It reads the open document's
text and offers:

- **Rezumat** — one-click summary + key terms + obligations & deadlines.
- **Riscuri & clauze** — flags risky/one-sided clauses, missing protections,
  and extracts the essential clauses.
- **Verificare lege RO** — checks the document against Romanian law /
  compliance and lists the governing legal references.
- **Ask anything** — free-form chat about the document (select text in Word
  first to ask about just that part).

Results can be copied or inserted straight back into the document.

## How it fits together

```
Microsoft Word
  └─ taskpane (docs/word-addin/) ── signs in with DocVex (Supabase) creds
        │  reads document text via Office.js
        ▼
  Supabase Edge Function  legal-assist  (verify_jwt on)
        │  builds a task-specific prompt
        ▼
  Anthropic Claude  →  markdown answer  →  rendered in the taskpane
```

- **Frontend**: static files in this folder (`taskpane.html/.css/.js`,
  `commands.html`, `config.js`, `manifest.xml`). No build step — Office.js and
  supabase-js load from their CDNs.
- **Backend**: [`supabase/functions/legal-assist`](../../supabase/functions/legal-assist/index.ts).
- **Auth**: the taskpane signs the user in with their normal DocVex
  (Supabase) email + password, so only DocVex users can spend the firm's
  Anthropic budget. `config.js` holds only the **public** Supabase URL + the
  publishable ("anon") key — the same values already shipped in the DocVex
  web bundle. No secret keys live in this folder.

## Hosting

GitHub Pages serves the repo's `docs/` folder at `https://docvex.ro/`, so once
this folder is pushed it is live at:

```
https://docvex.ro/word-addin/taskpane.html
https://docvex.ro/word-addin/manifest.xml
```

The `manifest.xml` URLs already point there. **To develop locally**, serve this
folder over HTTPS (e.g. `npx office-addin-debugging start manifest.xml`, or any
HTTPS static server) and replace every `https://docvex.ro/word-addin/` URL in
`manifest.xml` with your local URL (e.g. `https://localhost:3000/`).

## Deploy the backend (one-time)

The Edge Function reuses the `ANTHROPIC_API_KEY` secret that `legal-ai`
already uses, so no new secret is required.

```bash
supabase functions deploy legal-assist        # from the repo root
# Optional: pick a cheaper model than the claude-opus-4-7 default
supabase secrets set LEGAL_ASSIST_MODEL=claude-haiku-4-5
```

(`verify_jwt` stays on — the default — so the function only answers
authenticated DocVex users.)

## Install in Word (Windows desktop — sideload via a shared folder)

1. Put `manifest.xml` in a folder and share it (right-click → Properties →
   Sharing), e.g. `\\YOURPC\addins`. (Any SMB share works, including a local
   one shared with yourself.)
2. Word → **File ▸ Options ▸ Trust Center ▸ Trust Center Settings… ▸ Trusted
   Add-in Catalogs**. Paste the share path (`\\YOURPC\addins`), click **Add
   catalog**, tick **Show in Menu**, OK, and restart Word.
3. **Insert ▸ My Add-ins ▸ Shared Folder ▸ DocVex Legal AI ▸ Add**.
4. The **Legal AI** button appears on the **Home** tab — click it to open the
   taskpane, sign in with your DocVex account, and start.

> macOS Word: copy `manifest.xml` to
> `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/` then restart
> Word. Web Word / Microsoft 365 admin: upload the manifest under **Integrated
> apps** in the M365 admin center.

## Files

| File | Purpose |
| --- | --- |
| `manifest.xml` | Office add-in manifest — Word taskpane + Home-tab button. |
| `taskpane.html` | Taskpane UI shell (loads Office.js, supabase-js, our scripts). |
| `taskpane.css` | Styling (DocVex "Cream" palette, dark-mode aware, self-contained). |
| `taskpane.js` | Office.js doc read/write, DocVex sign-in, AI calls, markdown render. |
| `commands.html` | Minimal FunctionFile required by the manifest. |
| `config.js` | Public Supabase URL + anon key + Edge Function name. |

## Notes / next steps

- The ribbon icon currently reuses `https://docvex.ro/logo.png` at every size.
  Drop in dedicated 16/32/80 px PNGs and point the `bt:Image` resources at
  them for crisp ribbon rendering.
- Google sign-in is not wired in the taskpane (OAuth popups inside the Office
  dialog API add complexity) — email/password only for now.
- The document text sent to Claude is capped at 40,000 characters server-side.
