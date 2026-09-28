// "What do you want to make?" and the brief, READ FROM THE NEURAL NETWORK.
//
// The live network (lib/liveNetwork + the AI scan, lib/dataCollections) has
// already understood the project's files: every file's passport (type,
// subject, parties with their identifiers, facts, dates) and the Data
// collections. Two things are built on it here, so a document is set up from
// what the case holds instead of from a blank questionnaire:
//
//   suggestFromNetwork — the chooser's "From your files": what the case is, in
//     a sentence, and the documents it most likely needs next (catalogue
//     templates, or something the catalogue lacks), each with why and the
//     files that say so.
//   prefillBrief — the brief answered from the files: parties (a Data
//     collection's record where one holds them, else the details as the files
//     write them), the collections to draw on, and every question the files
//     answer. What they do not answer is left open and listed as missing.
//
// Both are ONE AI call over a compact digest of the network (no file is read
// again), cached per device against a signature of the network — a repeat
// costs nothing, and a file the live network adds changes the signature. Both
// go through lib/projectAi, so the project's pseudonymisation setting applies.

import { askProjectAi } from './projectAi';
import { DOC_TEMPLATES, templateById, foldText } from './docTemplates';
import { PARTY_FIELDS } from './docBrief';
import { localFolderApi } from './localFolder';
import { readProjectsDir } from './projectsDir';

const MODEL = 'claude-sonnet-4-6';
const SUGGEST_KEY = 'docvex:brief-network:suggest:v1:';
const PREFILL_KEY = 'docvex:brief-network:prefill:v1:';
const DIGEST_MAX = 60000;

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, max = 600) => String(v ?? '').trim().slice(0, max);
const parseJson = (text) => { const m = /\{[\s\S]*\}/.exec(String(text || '')); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The selected project's folder, as the brief finds it.
export async function projectDirFor(project, userId) {
  if (!project?.id) return null;
  try {
    const baseDir = readProjectsDir(userId || '_anonymous') || undefined;
    const { path } = await localFolderApi.projectDir(project.id, project.name, baseDir);
    return path || null;
  } catch { return null; }
}

// Everything the network knows about the project (lib/caseInsights'
// loadCaseData: the web index's understood files + the Data collections),
// with a signature that changes whenever the network does. Lazy: caseInsights
// is heavy and only needed once a project has been scanned.
export async function loadNetwork(dir, projectId) {
  if (!dir) return null;
  const { loadCaseData } = await import('./caseInsights');
  const data = await loadCaseData(dir, { projectId });
  const sig = djb2([
    ...data.files.map((f) => `${f.rel}:${f.size}:${f.mtime}`),
    ...data.collections.map((c) => `${c.rel}:${c.doc.facts.length}:${c.doc.sources.length}`),
  ].sort().join('|'));
  return { ...data, sig };
}

export const networkIsEmpty = (net) => !net || (!net.files.length && !net.collections.length);

// The network as the model reads it: the collections first (they are the
// case's subjects), then each file's passport, newest first, within a budget.
export function networkDigest(net, max = DIGEST_MAX) {
  const parts = [];
  for (const c of net.collections) {
    const d = c.doc;
    const rec = d.record && typeof d.record === 'object' ? Object.entries(d.record).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
    parts.push([
      `<collection path="${c.rel}" title="${d.title}">`,
      d.summary ? `Summary: ${d.summary.slice(0, 700)}` : '',
      rec ? `Record: ${rec.slice(0, 900)}` : '',
      d.facts.length ? `Facts: ${d.facts.slice(0, 20).map((f) => `${f.label}: ${f.value}`).join('; ')}` : '',
      d.timeline.length ? `Timeline: ${d.timeline.slice(0, 10).map((t) => `${t.date || '?'} ${t.event}`).join('; ')}` : '',
      `Files: ${d.sources.map((s) => s.rel || s.name).slice(0, 20).join(', ')}`,
      '</collection>',
    ].filter(Boolean).join('\n'));
  }
  const files = [...net.files].sort((a, b) => b.mtime - a.mtime);
  for (const f of files) {
    const u = f.u || {};
    parts.push([
      `<file path="${f.rel}">`,
      u.documentType ? `Type: ${u.documentType}` : '',
      u.subject ? `About: ${u.subject}` : '',
      u.text ? `Summary: ${String(u.text).slice(0, 400)}` : '',
      arr(u.parties).length ? `Parties: ${arr(u.parties).map((p) => `${p.name}${p.kind ? ` <${p.kind}>` : ''}${p.role ? ` (${p.role})` : ''}${arr(p.identifiers).length ? ` [${p.identifiers.join(', ')}]` : ''}`).join('; ')}` : '',
      arr(u.facts).length ? `Facts: ${arr(u.facts).slice(0, 12).map((x) => `${x.label}: ${x.value}`).join('; ')}` : '',
      arr(u.dates).length ? `Dates: ${arr(u.dates).slice(0, 8).map((x) => `${x.date} ${x.event}`).join('; ')}` : '',
      '</file>',
    ].filter(Boolean).join('\n'));
  }
  let out = '';
  for (const p of parts) { if (out.length + p.length > max) break; out += `${p}\n\n`; }
  return out;
}

const readCache = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
const writeCache = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full — the next open asks again */ } };

// Files the model named, kept only when the network has them.
function knownRels(net, list) {
  const known = [...net.files.map((f) => f.rel), ...net.collections.map((c) => c.rel)];
  return [...new Set(arr(list).map((x) => {
    const want = str(x, 1000).replace(/\\/g, '/');
    return known.find((k) => k === want) || known.find((k) => k.split('/').pop() === want.split('/').pop());
  }).filter(Boolean))].slice(0, 8);
}

// ── What the case needs next ────────────────────────────────────────────────
// → { situation, suggestions: [{ template, custom, why, from }] } | { error }
export async function suggestFromNetwork(net, { projectId, force = false } = {}) {
  if (networkIsEmpty(net)) return { situation: '', suggestions: [] };
  const key = SUGGEST_KEY + net.dir;
  const cached = readCache(key);
  if (!force && cached?.sig === net.sig && cached.result) return hydrateSuggestions(cached.result);

  const catalogue = DOC_TEMPLATES.map((t) => `${t.id} — ${t.label}`).join('\n');
  const prompt = `You help a Romanian lawyer decide which document to draft next in a case. An AI has already read the case's files; below is what it understood.
<case>
${networkDigest(net)}</case>

The document templates available (id — name):
<templates>
${catalogue}
</templates>

From the files ONLY, say in 1–2 sentences (in Romanian) what the case is about and where it stands, then suggest the 3–6 documents the case most plausibly needs NEXT — a step it has not taken yet (a pleading the facts call for, a contract being negotiated, a notice before a lawsuit, a reply to something received). Prefer templates; suggest a document outside the catalogue only when none fits. For each, "why" is one short sentence in Romanian naming the concrete fact from the files that calls for it, and "files" lists the paths that say so. Do not suggest documents the files show already exist unless the case needs another one.
Answer ONLY with JSON: {"situation":"…","suggestions":[{"template":"<id or null>","title":"<only when template is null>","why":"…","files":["path"]}]}`;
  const res = await askProjectAi({ messages: [{ role: 'user', content: prompt }], tools: false, model: MODEL, usageProject: projectId, usageAction: 'brief-suggest' });
  if (res?.error) return { error: String(res.error?.message || res.error) };
  const ans = parseJson(res.text);
  if (!ans) return { error: 'unreadable' };
  const result = {
    situation: str(ans.situation, 500),
    suggestions: arr(ans.suggestions).map((s) => {
      const tpl = templateById(str(s?.template, 80));
      const title = str(s?.title, 160);
      if (!tpl && !title) return null;
      return { templateId: tpl?.id || null, custom: tpl ? '' : title, why: str(s?.why, 300), from: knownRels(net, s?.files) };
    }).filter(Boolean).slice(0, 6),
  };
  writeCache(key, { sig: net.sig, result });
  return hydrateSuggestions(result);
}

function hydrateSuggestions(result) {
  return {
    situation: result.situation || '',
    suggestions: arr(result.suggestions).map((s) => ({ ...s, template: s.templateId ? templateById(s.templateId) : null }))
      .filter((s) => s.template || s.custom),
  };
}

// ── The brief, answered from the files ──────────────────────────────────────
// `questions` are lib/docBrief's for this template; `records` / `collections`
// are what DocBrief loaded (absolute paths). → { answers: { [id]: { text,
// choice, from } }, parties: [...], collections: [paths], missing: [..] }.
export async function prefillBrief(net, { template, custom, hint, questions, records = [], collections = [], projectId, force = false }) {
  if (networkIsEmpty(net)) return null;
  const key = `${PREFILL_KEY}${net.dir}:${template?.id || 'custom'}:${djb2(`${custom || ''}|${hint || ''}`)}`;
  const cached = readCache(key);
  let ans = !force && cached?.sig === net.sig ? cached.ans : null;
  if (!ans) {
    const asked = questions.filter((q) => !['parties', 'collections', 'preset'].includes(q.type)).map((q) => {
      const opts = arr(q.options).map((o) => `${o.id}="${o.label}"`).join(', ');
      return `- ${q.id} [${q.type}${q.other ? ', or free text' : ''}] ${q.title}${q.hint ? ` — ${q.hint}` : ''}${opts ? ` · options: ${opts}` : ''}`;
    }).join('\n');
    const fieldsHelp = `company: ${PARTY_FIELDS.org.map((f) => f.key).join(', ')}; person: ${PARTY_FIELDS.person.map((f) => f.key).join(', ')}`;
    const prompt = `A Romanian lawyer is about to draft: ${template ? template.label : (custom || 'a document')}.${hint ? `\nWhy this document: ${hint}` : ''}${custom && template ? `\nThey described it as: ${custom}` : ''}
An AI has already read the case's files; below is what it understood.
<case>
${networkDigest(net)}</case>

Fill in the drafting brief FROM THE FILES ONLY. Never invent or guess: a question the files do not answer is left out, and what the document needs but the files do not say goes in "missing". Write names, amounts, dates, addresses and identifiers exactly as the files write them. When files disagree, prefer the most official document (an identity document or state record over a contract, a contract over a letter).

The questions (id [type] title · options):
${asked}

For a choice / multi question give option ids in "choice" (only ids listed); when none fits and free text is allowed, put the answer in "text". For a text question give "text" (in Romanian). Every answer lists in "files" the paths it comes from.

"parties": the parties this document names, in the roles its clauses use (e.g. Vânzător / Cumpărător, Reclamant / Pârât), each: "role", "kind" ("person" or "org"), "collection" (the path of a <collection> whose record IS this party, else null), "fields" (what the files give, using these keys — ${fieldsHelp}), "files".
"collections": the paths of the <collection>s whose facts this document should draw on.

Answer ONLY with JSON: {"answers":{"<question id>":{"choice":[],"text":"","files":[]}},"parties":[{"role":"","kind":"person","collection":null,"fields":{},"files":[]}],"collections":[],"missing":["…"]}`;
    const res = await askProjectAi({ messages: [{ role: 'user', content: prompt }], tools: false, model: MODEL, usageProject: projectId, usageAction: 'brief-prefill' });
    if (res?.error) return { error: String(res.error?.message || res.error) };
    ans = parseJson(res.text);
    if (!ans) return { error: 'unreadable' };
    writeCache(key, { sig: net.sig, ans });
  }
  return shapePrefill(net, ans, { questions, records, collections });
}

// A Data collection's path inside the project → its absolute path in DocBrief.
function matchPath(rel, list, pathOf) {
  const want = str(rel, 1000).replace(/\\/g, '/').toLowerCase();
  if (!want) return null;
  const hit = list.find((x) => String(pathOf(x) || '').replace(/\\/g, '/').toLowerCase().endsWith(`/${want}`))
    || list.find((x) => String(pathOf(x) || '').replace(/\\/g, '/').split('/').pop().toLowerCase() === want.split('/').pop());
  return hit ? pathOf(hit) : null;
}

const nameKey = (v) => foldText(v).replace(/\b(s\.?c\.?|s\.?r\.?l\.?|s\.?a\.?|pfa)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').sort().join(' ');

function shapePrefill(net, ans, { questions, records, collections }) {
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const answers = {};
  for (const [id, a] of Object.entries(ans?.answers || {})) {
    const q = byId[id];
    if (!q || ['parties', 'collections', 'preset'].includes(q.type)) continue;
    const ids = new Set(arr(q.options).map((o) => o.id));
    let choice = arr(a?.choice).map((x) => str(x, 40)).filter((x) => ids.has(x));
    if (q.type === 'choice') choice = choice.slice(0, 1);
    const text = q.type === 'text' || q.other ? str(a?.text, 2000) : '';
    if (!choice.length && !text) continue;
    answers[id] = { ai: false, choice: q.type === 'choice' && text ? [] : choice, text, auto: { from: knownRels(net, a?.files) } };
  }

  const parties = arr(ans?.parties).map((p) => {
    const kind = p?.kind === 'org' || p?.kind === 'company' ? 'org' : 'person';
    const role = str(p?.role, 80);
    if (!role) return null;
    const allowed = new Set(PARTY_FIELDS[kind].map((f) => f.key));
    const fields = Object.fromEntries(Object.entries(p?.fields || {}).map(([k, v]) => [k, str(v, 300)]).filter(([k, v]) => allowed.has(k) && v));
    // The record: the collection the AI named, else one whose name is the party's.
    let path = p?.collection ? matchPath(p.collection, records, (r) => r._path) : null;
    if (!path) {
      const want = nameKey(fields.legalName || [fields.lastName, fields.firstName].filter(Boolean).join(' '));
      const rec = want && records.find((r) => nameKey(r.legalName || r.name) === want);
      path = rec?._path || null;
    }
    const rec = path && records.find((r) => r._path === path);
    const auto = { from: knownRels(net, p?.files) };
    if (rec) return { role, kind: rec.kind, source: 'collection', path, fields: {}, auto };
    const named = kind === 'org' ? fields.legalName : (fields.lastName || fields.firstName);
    return { role, kind, source: named ? 'typed' : 'blank', path: null, fields, auto };
  }).filter(Boolean).slice(0, 8);

  const cols = [...new Set(arr(ans?.collections).map((rel) => matchPath(rel, collections, (c) => c.path)).filter(Boolean))];
  const missing = arr(ans?.missing).map((m) => str(m, 240)).filter(Boolean).slice(0, 8);
  return { answers, parties, collections: cols, missing };
}
