// RESEARCH'S AI — rebuilt from scratch (2026-09-28) after the first version
// proved slow, inconsistent and, at times, never answered. It keeps exactly
// three things and nothing else:
//
//   1. EXACT MATCH — a line that IS an identifier (an act, a court file, a
//      CUI, a CAEN code) is answered by the portal, not the AI
//      (`exactMatchPage`). A QUESTION that merely mentions one ("Ce spune
//      Legea 31/1990 despre SRL?") goes to the AI.
//   2. PROMPT DETECTION — Auto picks the model for the question
//      (lib/researchModels `routeModel`).
//   3. THE PROJECT'S FILES — the selected project's digest (lib/aiProjectContext),
//      when the composer's box is ticked.
//
// No rule blocks, no steers, no portal results pasted in, no sources protocol:
// the question, the conversation so far and (optionally) the project. Every
// step has a TIME LIMIT, so a turn always ends — with an answer or a message
// saying what failed.

import { pageForQuery } from './legalSearch';
import { askProjectAi } from './projectAi';
import { buildProjectDigest } from './aiProjectContext';
import { researchModel, routeModel } from './researchModels';

export const ROUTE_LIMIT_MS = 8_000;
export const CONTEXT_LIMIT_MS = 12_000;
export const ANSWER_LIMIT_MS = 120_000;
const HISTORY_TURNS = 10;          // the last N messages sent back with a question
const CONTEXT_TTL_MS = 5 * 60_000; // a project digest is reused this long

const TIMEOUT = Symbol('timeout');
const withLimit = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(TIMEOUT), ms))]);

// ── 1. Exact match ─────────────────────────────────────────────────────────
// Question words (Romanian + English) that make a line a question, whatever
// identifier it carries.
const QUESTION_WORDS = /^(ce|cum|care|c[aâ]nd|unde|de ce|c[aâ]t|c[aâ]te|cine|este|sunt|exist[aă]|pot|poate|trebuie|explic\w*|rezum\w*|spune\w*|what|how|which|when|where|why|who|is|are|can|does|do|should|explain\w*|summari[sz]e\w*|tell)\b/i;
// The words an IDENTIFIER is written with (folded: no diacritics, lower case)
// — the kind of act, "nr." / "din", the codes' names, the platform prefixes.
// A line holding any OTHER word ("Legea 31/1990 capital social minim") is
// asking something about the identifier, and goes to the AI.
const ID_WORDS = new Set([
  'lege', 'legea', 'legii', 'oug', 'og', 'hg', 'ordonanta', 'ordonantei', 'urgenta', 'guvernului', 'hotarare', 'hotararea', 'hotararii',
  'ordin', 'ordinul', 'decret', 'decretul', 'decizie', 'decizia', 'regulament', 'regulamentul', 'directiva', 'nr', 'din', 'de', 'a', 'al', 'si',
  'codul', 'cod', 'civil', 'penal', 'muncii', 'fiscal', 'procedura', 'administrativ', 'rutier', 'silvic', 'vamal',
  'caen', 'cui', 'cif', 'ro', 'dosar', 'dosarul', 'dosare', 'anaf', 'rev', 'privind',
]);
/** The portal page a line opens WHEN the line is an identifier and nothing
 *  more; null for anything that reads as a question. */
export function exactMatchPage(raw) {
  const q = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!q || q.includes('?')) return null;
  const f = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (QUESTION_WORDS.test(f)) return null;
  const words = f.split(/[^a-z0-9./-]+/).filter(Boolean);
  if (words.some((w) => /[a-z]/.test(w) && !/\d/.test(w) && !ID_WORDS.has(w.replace(/\.+$/, '')))) return null;
  const hit = pageForQuery(q);
  return hit?.page?.type === 'item' ? hit.page : null;
}

// ── 2. The model ───────────────────────────────────────────────────────────
/** The model for `question`: the picker's choice, or Auto's pick (8s at most,
 *  then Sonnet 5). → { run, info } — `info` is what the byline prints. */
export async function chooseModel(choice, question) {
  let pick = researchModel(choice);
  let route = null;
  if (pick.id === 'auto') {
    const r = await withLimit(routeModel(question), ROUTE_LIMIT_MS);
    route = r === TIMEOUT
      ? { id: 'claude-sonnet-5', run: 'claude-sonnet-5', reasoning: 'Auto took too long to decide, so the general-purpose model was used.', routedOk: false }
      : r;
    pick = researchModel(route.id);
  }
  const run = route?.run || pick.run;
  return {
    run,
    info: { id: run, picked: pick.id, auto: !!route, reasoning: route?.reasoning || '', routedOk: route ? route.routedOk : true, substituted: pick.unavailable ? pick.name : null },
  };
}

// ── 3. The project's files ─────────────────────────────────────────────────
// The digest is built once per project and reused for a few minutes (it reads
// every data collection and the files' knowledge — too slow to redo per
// question), and can be WARMED as soon as the page knows the project.
const contextCache = new Map(); // projectId → { at, text } | { at, promise }
export function projectContext(project, files) {
  if (!project?.id) return Promise.resolve('');
  const c = contextCache.get(project.id);
  if (c?.text != null && Date.now() - c.at < CONTEXT_TTL_MS) return Promise.resolve(c.text);
  if (c?.promise) return c.promise;
  const promise = buildProjectDigest({ project, files: files || [] })
    .then((text) => { contextCache.set(project.id, { at: Date.now(), text: text || '' }); return text || ''; })
    .catch(() => { contextCache.delete(project.id); return ''; });
  contextCache.set(project.id, { at: Date.now(), promise });
  return promise;
}
export function forgetProjectContext(projectId) {
  if (projectId) contextCache.delete(projectId); else contextCache.clear();
}

// ── The answer ─────────────────────────────────────────────────────────────
/**
 * Ask the AI. `history` = the chat's earlier messages ({ who, text }), the
 * last few sent back; `context` = the project digest or ''.
 * → { text } | { error }.
 */
export async function askResearch({ question, history = [], context = '', model, projectName }) {
  const turns = [];
  for (const m of history.slice(-HISTORY_TURNS)) {
    const role = m.who === 'me' ? 'user' : 'assistant';
    const content = String(m.text || '').trim();
    if (!content) continue;
    // Keep the roles alternating: two in a row of one role → the later wins.
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1] = { role, content };
    else turns.push({ role, content });
  }
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const content = context
    ? `<project_files project="${projectName || ''}">\n${context}\n</project_files>\n\n${question}`
    : question;
  const res = await withLimit(
    askProjectAi({ messages: [...turns, { role: 'user', content }], projectName, fileNames: [], model, tools: false, usageAction: 'research' }),
    ANSWER_LIMIT_MS,
  );
  if (res === TIMEOUT) return { error: 'The AI took more than two minutes and was stopped. Try again, or pick a faster model.' };
  if (res?.error) return { error: typeof res.error === 'string' ? res.error : (res.error?.message || 'The AI did not answer.') };
  const text = String(res?.text || '').trim();
  return text ? { text } : { error: 'The AI sent back an empty answer.' };
}

/** A time limit for anything else (the portals, the summary's record). */
export { withLimit, TIMEOUT };
