// check-vertex — test a Google Cloud service-account key against Vertex AI
// BEFORE it goes into the Supabase secrets (npm run check:vertex).
//
//   npm run check:vertex -- <key.json> [project-id] [region]
//
// The project id defaults to the key's own project_id, the region to
// europe-west1 (what the Edge Functions default to). It signs in with the key
// exactly as supabase/functions/_shared/claude.ts does (an RS256 JWT exchanged
// for a cloud-platform token), then sends every model the app uses a one-word
// request, and reports which ones answer. Nothing about DocVex's users is sent.
// The key never leaves this computer except to Google's token endpoint.
import fs from 'node:fs';
import crypto from 'node:crypto';

// Keep in step with VERTEX_MODEL_MAP in supabase/functions/_shared/claude.ts.
const MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5@20251001',
];
const EU_REGION = /^europe-/;

const [keyPath, projectArg, regionArg] = process.argv.slice(2);
if (!keyPath) {
  console.error('Usage: npm run check:vertex -- <service-account-key.json> [project-id] [region]');
  process.exit(2);
}
const sa = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const project = projectArg || sa.project_id;
const region = regionArg || 'europe-west1';
if (!sa.client_email || !sa.private_key) {
  console.error('That file is not a service-account key (no client_email / private_key).');
  process.exit(2);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), sa.private_key);
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claims}.${b64url(sig)}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`sign-in refused (${res.status}): ${data.error_description || data.error || 'no token'}`);
  }
  return data.access_token;
}

async function tryModel(token, model) {
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}`
    + `/locations/${region}/publishers/anthropic/models/${model}:rawPredict`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      anthropic_version: 'vertex-2023-10-16',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
    }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text();
  let why = text.slice(0, 200);
  try { why = JSON.parse(text)?.error?.message || why; } catch { /* raw text */ }
  const hint = res.status === 403 ? ' → give the service account "Vertex AI User", or enable the Vertex AI API'
    : res.status === 404 ? ' → enable this model in Model Garden, or this region does not serve it'
    : res.status === 429 ? ' → quota: request Claude quota for this region in IAM & Admin → Quotas'
    : '';
  return { ok: false, why: `${res.status} ${why}${hint}` };
}

console.log(`Project ${project} · region ${region} · ${sa.client_email}`);
if (!EU_REGION.test(region)) console.log(`WARNING: ${region} is not an EU region — CLAUDE_REQUIRE_EU=1 will refuse it.`);

let token;
try {
  token = await accessToken();
  console.log('Sign-in: OK');
} catch (err) {
  console.error(`Sign-in: FAILED — ${err.message}`);
  process.exit(1);
}

let failed = 0;
for (const model of MODELS) {
  const r = await tryModel(token, model);
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${model}${r.ok ? '' : `  — ${r.why}`}`);
}
console.log(failed
  ? `\n${failed} model(s) failed. Fix them before setting the Supabase secrets — the app calls each of these.`
  : '\nEverything answers. Safe to set the Supabase secrets (see CLAUDE.md → Vertex setup).');
process.exit(failed ? 1 : 0);
