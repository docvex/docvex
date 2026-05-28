# legal-ai

Claude-powered AI for the **Legal Newsfeed** (the Newsletter tab). Raw REST
to the Anthropic Messages API — no SDK bundled into the Deno runtime.

Two actions, dispatched on the request body's `action` field:

| Action | Who calls it | What it does |
| --- | --- | --- |
| `digest` | The renderer (`lib/legalFeed.js` → `getWeeklyDigest`), any signed-in user | Read-only. Generates the "AI weekly" briefing paragraph across the most recent `legal_updates`. Result is cached 1 h in `sessionStorage`. |
| `ingest` | An operator / cron / scraper | Classifies + summarises raw legal text into `legal_updates` rows (service role). Gated behind the `x-ingest-secret` header. |

## Secrets

Set these in **Supabase → Project → Edge Functions → Secrets** (NOT in the
repo `.env` — that file is for the Vite client build and is shipped to users).

| Secret | Required? | How to get it / what to put |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Yes**, for any AI output | Create at https://console.anthropic.com → add billing → **API keys** → **Create Key** (`sk-ant-...`). Without it, `digest` returns `{ ok:false, error:"ai_not_configured" }` (the Newsletter falls back to a computed line) and `ingest` 500s. |
| `LEGAL_INGEST_SECRET` | Only to enable `ingest` | A random string **you invent** — it's a password guarding the ingest action so arbitrary signed-in users can't write to the global feed. While unset, `ingest` returns 403 and the feed only grows via seed / manual SQL. Generate one in PowerShell: `[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")` |
| `LEGAL_AI_MODEL` | No | Overrides the default model `claude-opus-4-7`. Set to `claude-haiku-4-5` to cut digest cost. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Auto | Injected by the platform — nothing to do. |

Setting secrets via the CLI instead of the dashboard:

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxx --project-ref pntxlvhkqfryyyxlqytr
supabase secrets set LEGAL_INGEST_SECRET=<random> --project-ref pntxlvhkqfryyyxlqytr
# optional:
supabase secrets set LEGAL_AI_MODEL=claude-haiku-4-5 --project-ref pntxlvhkqfryyyxlqytr
```

Deploy is `verify_jwt = true`, so `digest` requires a real user JWT (the
app sends it automatically when signed in). `ingest` additionally requires
the `x-ingest-secret` header to match `LEGAL_INGEST_SECRET`.

## Adding new updates to the feed (ingest)

Each item supplies the raw text; Claude fills in `category`, `impact`,
`summary` (Romanian), `areas`, and `citations`. `slug` is optional — it's
derived from the title when omitted, and `ON CONFLICT (slug)` makes
re-runs idempotent. Max 20 items per call.

```bash
curl -X POST "https://pntxlvhkqfryyyxlqytr.supabase.co/functions/v1/legal-ai" \
  -H "Authorization: Bearer <a-valid-user-or-service-role-JWT>" \
  -H "x-ingest-secret: <LEGAL_INGEST_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "ingest",
    "items": [
      {
        "title": "OUG 99/2026 — modificări la regimul TVA pentru servicii digitale",
        "source": "Monitorul Oficial · OUG 99/2026",
        "published_at": "2026-06-01T08:00:00Z",
        "raw_content": "<full text of the legal update goes here>"
      }
    ]
  }'
```

Returns `{ ok: true, results: [{ slug, ok, error? }, ...] }`.
