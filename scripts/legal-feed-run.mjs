// Runs the Legal Newsfeed job from this machine — the same walk the desktop
// app does (lib/legalFeedSync.js), with the operator key instead of an admin's
// session. For a backfill, or to check the pipeline without opening the app.
//
//   LEGAL_FEED_KEY=<key> node scripts/legal-feed-run.mjs [--dry] [--back=12]
//
// The key is the Vault secret `legal_feed_operator_key` (migration 039):
//   select decrypted_secret from vault.decrypted_secrets where name = 'legal_feed_operator_key';
//
// It has to run on a ROMANIAN connection: legislatie.just.ro refuses others
// (see supabase/functions/legal-feed-sync/README.md). The Supabase URL and
// anon key are read from .env.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const back = Number((args.find((a) => a.startsWith('--back=')) || '').split('=')[1]) || 12;

const env = Object.fromEntries(
  readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
    .map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const url = env.VITE_SUPABASE_URL;
const anon = env.VITE_SUPABASE_ANON_KEY;
const key = process.env.LEGAL_FEED_KEY;
if (!url || !anon) throw new Error('.env needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
if (!key) throw new Error('set LEGAL_FEED_KEY (see the header of this file)');

// The function's own portal code, bundled for Node on the fly.
const out = path.join(root, 'node_modules', '.cache', 'legal-feed-portal.mjs');
await build({
  entryPoints: [path.join(root, 'supabase/functions/legal-feed-sync/portal.ts')],
  outfile: out, format: 'esm', platform: 'node', bundle: true, logLevel: 'silent',
});
const { Portal } = await import(pathToFileURL(out).href);

async function call(body) {
  const res = await fetch(`${url}/functions/v1/legal-feed-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anon}`, 'x-feed-key': key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`${body.action}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const plan = await call({ action: 'plan' });
if (plan.busy) { console.log('Another run holds the lease — try again in a few minutes.'); process.exit(0); }

const portal = new Portal();
for (const { year, start } of plan.years) {
  let n = start ?? Math.max(1, (await portal.recentIssue(year)) - back);
  let found = start ? start - 1 : 0;
  let empties = 0;
  const acts = [];
  for (let steps = 0; steps < 60; steps += 1, n += 1) {
    const got = await portal.issue(year, n);
    if (got.length) { acts.push(...got); found = Math.max(found, n); empties = 0; }
    else if (n > found && (empties += 1) >= 3) break;
  }
  console.log(`${year}: ${acts.length} acts, issues up to nr. ${found}`);
  // The function reads the portal's own record shape; the issue it was
  // printed in rides at the end of the title, as the portal writes it.
  const records = acts.map((a) => ({
    link: a.link, tipAct: a.type, numar: a.number, emitent: a.issuer, dataVigoare: a.inForce,
    titlu: `${a.title} EMITENT ${a.issuer} PUBLICAT ÎN ${a.moRef}`,
    text: a.text.slice(0, 60000),
  }));
  const res = await call({ action: 'submit', year, lastIssue: found, final: true, dryRun, records });
  if (dryRun) {
    const { decisions, ...summary } = res;
    console.log(summary);
    for (const d of decisions.filter((x) => x.status === 'relevant')) console.log('  relevant:', d.label, '—', d.reason);
  } else {
    console.log('submitted — judged in the background; see legal_feed_state.last_run');
  }
}
