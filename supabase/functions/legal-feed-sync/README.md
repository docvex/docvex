# legal-feed-sync

Fills the **Legal Newsfeed** (Newsletter tab, `legal_updates`) from Monitorul
Oficial, via the Ministry of Justice's free web service at
legislatie.just.ro.

## Why the desktop app reads the portal

legislatie.just.ro geo-checks every caller: its nginx stamps `X-Country` and
`X-Block` on each answer, and it drops every connection from Supabase's
eu-west-1 region, even for its public home page. The same requests from a
Romanian connection succeed. So this function **never contacts the portal**.
The desktop app reads it over the user's own connection
(`src/lib/legalFeedSync.js`, through the same main-process channel the
Legislation tab uses) and submits the records here. Migration 037 first
scheduled the job server-side; migration 038 removed that schedule.

## What a run does

1. **`plan`** (the app asks): this function returns where to start in each
   year's Monitorul Oficial, six issues behind the last one found
   (`legal_feed_state` → `mo_issue:<year>`). It also takes a 10-minute lease,
   so two open apps don't both walk. With nothing remembered, the app takes
   its own bearing: a guess from the date, stepped back until an issue
   answers, then about a week behind that.
2. **The app walks issue by issue.** It searches titles for
   "Monitorul Oficial nr. N din" and its "bis" supplement, and stops after
   three empty numbers in a row. The portal's own listing of a year's acts is
   unstable (three reads of its last thirty pages each saw 50–65% of what they
   saw together), so the job doesn't use it.
3. **`submit`** (one request per run): the records come here. What happens to
   them:
   - Records that aren't legislatie.just.ro documents from the walked year are
     rejected.
   - Acts already judged are skipped (`legal_feed_acts`).
   - **Free rules** (`portal.ts` → `freeVerdict`) drop what the record alone
     shows to concern no client (roughly four acts in five). Annexes are
     folded into the act that approves them.
   - **Screening:** one `claude-sonnet-5` call per 40 acts (Haiku proved too lenient).
   - **Summaries:** `claude-opus-5` writes up to 10 feed rows per run. A
     relevant act keeps its text (`body`) until it's summarised, because the
     server can't fetch it again. Failures retry up to three times.

   This all runs after the function has answered.

**Who can submit:** app admins only (`is_app_admin`). The feed is global and
presented as the law, so records from any other account are refused. In
practice the feed moves whenever an admin has the desktop app open. The app
checks every 30 minutes and runs at most every 3 hours per machine.

## Trying it without consequences

In the desktop app, go to **Debug → Legal feed: dry run**. The app walks the
issues and the function answers with the decisions it would make. Nothing is
written and nothing is summarised, though one screening call is made. The
full answer is printed to the console.

## Checking on it

```sql
select value from legal_feed_state where key = 'last_run';          -- last report
select status, count(*) from legal_feed_acts group by 1;             -- verdicts
select title, reason from legal_feed_acts where status = 'rejected'  -- what the model dropped
  order by first_seen_at desc limit 50;
```

## Testing the portal code locally

`portal.ts` uses no Deno APIs, so it runs under Node from a Romanian
connection:

```bash
npx esbuild supabase/functions/legal-feed-sync/portal.ts --format=esm --platform=node --outfile=/tmp/portal.mjs
node -e "import('/tmp/portal.mjs').then(async ({ Portal }) => console.log((await new Portal().issue(2026, 803)).length))"
```

## Secrets

`ANTHROPIC_API_KEY` (shared with `legal-ai`). Optional: `LEGAL_FEED_MODEL`
(summaries, default `claude-opus-5`) and `LEGAL_FEED_TRIAGE_MODEL` (default
`claude-sonnet-5`). Deployed with **verify_jwt on**.

Both models are reached through the Anthropic API under its commercial terms
(no training on inputs), the same as the other functions. What they receive
is public legislation, not client material.
