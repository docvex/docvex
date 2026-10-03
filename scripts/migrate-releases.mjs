// Copy every GitHub release of the SOURCE repo into the public RELEASES repo
// (release-repo.json), so the Updates tab — which reads the releases repo —
// lists them all.
//
//   node scripts/migrate-releases.mjs                 # dry run: lists what it would copy
//   node scripts/migrate-releases.mjs --go            # copies notes AND installers
//   node scripts/migrate-releases.mjs --go --no-assets  # notes only (no installers)
//   node scripts/migrate-releases.mjs --from owner/repo # another source repo
//
// Needs GITHUB_TOKEN with write access to the releases repo.
//
// • A tag the releases repo already has is skipped, so a run that stopped
//   half way can simply be run again.
// • Every copy is created with make_latest=false: the releases repo's own
//   newest release stays "Latest", which is what update.electronjs.org and the
//   in-app updater serve. Old installers must never be offered as an update.
// • GitHub dates a release by when it is created, so the original date goes
//   into the notes as a hidden `<!-- docvex-published: … -->` comment, which
//   the Updates tab reads (pages/Updates.jsx releaseDate).
// • The tag is created on the releases repo's default branch (that repo has
//   no source history to point at).
// • Drafts are not copied.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const GO = args.includes('--go');
const NO_ASSETS = args.includes('--no-assets');
const fromIdx = args.indexOf('--from');
const SOURCE = fromIdx >= 0 ? args[fromIdx + 1] : 'petreluca1105-dotcom/docvex';
const { owner, name } = JSON.parse(readFileSync(new URL('../release-repo.json', import.meta.url), 'utf8'));
const TARGET = `${owner}/${name}`;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('GITHUB_TOKEN is not set.'); process.exit(1); }

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'docvex-migrate-releases',
};

async function api(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function allReleases(repo) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`/repos/${repo}/releases?per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

const mb = (n) => `${Math.round(n / 1048576)} MB`;

const [source, target, targetRepo] = await Promise.all([allReleases(SOURCE), allReleases(TARGET), api(`/repos/${TARGET}`)]);
const have = new Set(target.map((r) => r.tag_name));
const todo = source.filter((r) => !r.draft && !have.has(r.tag_name)).reverse(); // oldest first
const bytes = todo.reduce((n, r) => n + r.assets.reduce((m, a) => m + a.size, 0), 0);

console.log(`${SOURCE} → ${TARGET} (default branch ${targetRepo.default_branch})`);
console.log(`${source.length} releases in the source, ${target.length} already in the target; ${todo.length} to copy${NO_ASSETS ? ' (notes only)' : `, ${mb(bytes)} of installers`}.`);
for (const r of todo) console.log(`  ${r.tag_name}  ${r.published_at?.slice(0, 10)}  ${r.assets.length} asset(s)${r.prerelease ? '  pre-release' : ''}`);
if (!GO) { console.log('\nDry run. Add --go to copy.'); process.exit(0); }

for (const r of todo) {
  const body = `${r.body || ''}\n\n<!-- docvex-published: ${r.published_at || r.created_at} -->`;
  const made = await api(`/repos/${TARGET}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: r.tag_name,
      target_commitish: targetRepo.default_branch,
      name: r.name || r.tag_name,
      body,
      draft: false,
      prerelease: r.prerelease,
      make_latest: 'false',
    }),
  });
  console.log(`✓ ${r.tag_name} created`);
  if (NO_ASSETS) continue;
  for (const a of r.assets) {
    const dl = await fetch(a.url, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'follow' });
    if (!dl.ok) throw new Error(`download ${a.name} → ${dl.status}`);
    const data = Buffer.from(await dl.arrayBuffer());
    const uploadUrl = made.upload_url.replace(/\{.*\}$/, '') + `?name=${encodeURIComponent(a.name)}${a.label ? `&label=${encodeURIComponent(a.label)}` : ''}`;
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': a.content_type || 'application/octet-stream', 'Content-Length': String(data.length) },
      body: data,
    });
    if (!up.ok) throw new Error(`upload ${a.name} → ${up.status} ${await up.text()}`);
    console.log(`    ↑ ${a.name} (${mb(a.size)})`);
  }
}
console.log('\nDone. Every copied release is marked not-latest; the releases repo\'s newest release is still the one served as the update.');
