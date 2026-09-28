// THE ONE AI — Research and the Doc Viewer's advisor both run on this file
// (2026-09-28, rebuilt after both had grown into a tangle of rules and steers
// that answered slowly and inconsistently). Change it here and both change.
//
// What each surface may do is DATA (`AI_SURFACES`), not code paths:
//
//                         Research   File viewer
//   portals + APIs           yes         yes      — records DocVex reads for
//                                                   the question (acts, court
//                                                   files, companies, CAEN)
//   Auto (model routing)     yes         yes
//   legislation highlight    yes         yes      — references in the answer
//                                                   marked and clickable
//   project files            yes         yes      — the composer's switch
//   create files              no         yes      — write_document / ask_user
//   edit files                no         yes      — paragraph edits, edit blocks
//
// NO standing rules: a turn is the conversation so far, the question and the
// DATA gathered for it, each in a self-describing block (<portal_record>,
// <project_files>, <open_file>). The only instructions sent are the ones a
// CAPABILITY needs to work (how to save a version, how to write an edit) and
// they ride only on the surface that has that capability. Every instruction
// text lives in `AI_PROMPTS` below, and the Debug tab shows them all
// (pages/DebugAiSettings) — nothing the AI is told is hidden elsewhere.
//
// Every step has a TIME LIMIT, so a turn always ends.

import { pageForQuery } from './legalSearch';
import { askProjectAi, askProjectAiStream, warmProjectAi } from './projectAi';
import { buildProjectDigest } from './aiProjectContext';
import { findFollowableRefs } from './lawRefs';
import { recordText, viewForRef } from './portalRecords';

// ── The surfaces and what they may do ──────────────────────────────────────
export const AI_SURFACES = {
  research: {
    id: 'research', label: 'Research', where: 'pages/Research',
    portals: true, auto: true, legalHighlight: true, projectFiles: true,
    openFile: false, createFiles: false, editFiles: false,
    usageAction: 'research',
  },
  viewer: {
    id: 'viewer', label: 'File viewer (Doc Viewer advisor)', where: 'pages/DocViewer',
    portals: true, auto: true, legalHighlight: true, projectFiles: true,
    openFile: true, createFiles: true, editFiles: true,
    usageAction: 'viewer',
  },
};
export const CAPABILITIES = [
  { id: 'portals', label: 'Portals and connected APIs', what: 'Acts, court files, companies and CAEN codes named in the question are read from legislatie.just.ro, portal.just.ro, anaf.ro and the CAEN nomenclature, and handed to the model.' },
  { id: 'auto', label: 'Auto model', what: 'The model is picked per question by a small routing call (Haiku 4.5, your routing prompt).' },
  { id: 'legalHighlight', label: 'Legislation highlight', what: 'Acts, codes, CAEN codes, court files and CUIs in the answer are marked in their platform’s colour; a click opens them.' },
  { id: 'projectFiles', label: 'Project files', what: 'The project digest (every file, data collection and what the scan read) is handed over when the composer’s switch is on.' },
  { id: 'openFile', label: 'The open file', what: 'The file on show is handed over in full (≤40,000 characters).' },
  { id: 'createFiles', label: 'Create files', what: 'The model may save a new version of the document (write_document) or ask questions first (ask_user) — written by your Playbook rules.' },
  { id: 'editFiles', label: 'Edit files', what: 'The model may rewrite a picked paragraph in place and change project files through edit blocks, each with Undo — edited by your Playbook rules.' },
];

// ── Limits ─────────────────────────────────────────────────────────────────
export const AI_LIMITS = {
  routeMs: 4_000,          // Auto's routing call (when the quick check can't tell)
  contextMs: 12_000,       // the project digest
  portalsMs: 6_000,        // reading the portal records (the answer starts without the late ones)
  answerMs: 120_000,       // an answer
  draftMs: 240_000,        // writing a document (Office builds run 80s+)
  historyTurns: 10,        // earlier messages sent back with a question
  contextTtlMs: 5 * 60_000,// a project digest is reused this long
  portalRefs: 4,           // references read per question
  portalChars: 15_000,     // characters of one record handed over
  openFileChars: 40_000,   // characters of the open file handed over
  effort: 'medium',        // output_config.effort on every turn (constant, so the cache holds)
  warmCache: true,         // write the prompt cache while the question is typed
  warmEveryMs: 4 * 60_000, // at most once per model + data this often (the cache lives 5 min)
};

const TIMEOUT = Symbol('timeout');
const withLimit = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(TIMEOUT), ms))]);
export { withLimit, TIMEOUT };

// ── Models ─────────────────────────────────────────────────────────────────
// `run` is what is requested from project-ai, which allow-lists model ids
// (MODEL_ALLOW): Fable 5.1 is not on it yet, so a Fable pick runs on Opus 5.5
// and the byline says so.
export const AI_MODELS = [
  { id: 'auto', label: 'Auto', tip: 'Picks the model for each question' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1 (not enabled)', name: 'Fable 5.1', run: 'claude-opus-5-5', unavailable: true, tip: 'Not enabled on the server yet — answers with Opus 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', name: 'Opus 5.5', run: 'claude-opus-5-5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', name: 'Sonnet 5', run: 'claude-sonnet-5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', name: 'Opus 4.8', run: 'claude-opus-4-8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', name: 'Opus 4.7', run: 'claude-opus-4-7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', name: 'Sonnet 4.6', run: 'claude-sonnet-4-6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', name: 'Haiku 4.5', run: 'claude-haiku-4-5' },
];
const BY_ID = new Map(AI_MODELS.map((m) => [m.id, m]));
export const aiModel = (id) => BY_ID.get(id) || BY_ID.get('auto');
export const modelName = (id) => BY_ID.get(id)?.name || id || 'unknown model';
export const FALLBACK_MODEL = 'claude-sonnet-5';
export const ROUTER_MODEL = 'claude-haiku-4-5';

// ── The settings, ONE for both surfaces ───────────────────────────────────
// Picking a model or switching the project's files off in Research does the
// same in the file viewer, and back (localStorage is shared by every window).
const MODEL_KEY = 'docvex:ai:model:v1';
const FILES_KEY = 'docvex:ai:project-files:v1';
const STYLE_KEY = 'docvex:ai:style:v1';
export const AI_SETTING_KEYS = { model: MODEL_KEY, projectFiles: FILES_KEY, style: STYLE_KEY };

// ── How the AI answers: the style presets (the dropdown by Research's search,
// and in the file viewer's composer). Sent as one line at the END of the
// question — the volatile tail, so the cached prefix is untouched.
export const AI_STYLES = [
  { id: 'claude', label: 'Claude', tip: 'Claude’s own default way of answering', prompt: '' },
  {
    id: 'docvex', label: 'DocVex', tip: 'Formal, no emojis — like a colleague at a law firm',
    prompt: '[Style: Answer as an experienced legal professional at a law firm would write to a client or a colleague — a formal, courteous and measured register, precise legal terminology, complete sentences. No emojis, no exclamation marks, no slang or casual phrasing, no chatty openers or sign-offs.]',
  },
  {
    id: 'direct', label: 'Direct', tip: 'Just the information, straight away',
    // Direct = the DATA, straight — still courteous (AI_MANNERS holds): a brief
    // polite greeting and closing stay, only padding and digressions go.
    prompt: '[Style: Keep your usual courtesy — a brief polite greeting and a brief polite closing — but between them give the information directly: the answer itself first, no restating the question, no digressions or padding, no unrequested follow-up offers. Short sentences or a tight list; only what was asked.]',
  },
];
const STYLE_BY_ID = new Map(AI_STYLES.map((x) => [x.id, x]));
export const aiStyle = (id) => STYLE_BY_ID.get(id) || AI_STYLES[0];
export function loadAiStyle() {
  try { const v = localStorage.getItem(STYLE_KEY); return STYLE_BY_ID.has(v) ? v : 'claude'; } catch { return 'claude'; }
}
export function saveAiStyle(id) {
  try { localStorage.setItem(STYLE_KEY, id); } catch { /* quota */ }
  try { window.dispatchEvent(new CustomEvent('docvex:ai-settings')); } catch { /* no window */ }
}
/** The question with the style line after it (outgoing copy only). */
export const withStyle = (text, styleId) => {
  const p = aiStyle(styleId).prompt;
  return p ? `${text}\n\n${p}` : text;
};
export function loadAiModel() {
  try {
    const v = localStorage.getItem(MODEL_KEY) || localStorage.getItem('docvex:research:model:v1');
    return BY_ID.has(v) ? v : 'auto';
  } catch { return 'auto'; }
}
export function saveAiModel(id) {
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* quota */ }
  try { window.dispatchEvent(new CustomEvent('docvex:ai-settings')); } catch { /* no window */ }
}
export function loadAiProjectFiles() {
  try { return localStorage.getItem(FILES_KEY) !== '0'; } catch { return true; }
}
export function saveAiProjectFiles(on) {
  try { localStorage.setItem(FILES_KEY, on ? '1' : '0'); } catch { /* quota */ }
  try { window.dispatchEvent(new CustomEvent('docvex:ai-settings')); } catch { /* no window */ }
}

// ── HOW EVERY AI ADDRESSES THE USER (2026-09-28, the user's own text, word
// for word) — sent with every conversational turn, app-wide, as the FIRST
// part of the cached `context` (so it costs nothing after the first turn and
// the warm-up writes the same prefix). Not sent where the answer is read by
// code, not by the user (paragraph rewrites, the router, JSON extractors):
// a greeting there would break the parsing. The last line keeps courtesy
// out of what the AI WRITES for others (documents, files).
export const AI_MANNERS = `<system_instructions>
You are an exceptionally polite, respectful, and professional AI assistant built into this application. You must strictly adhere to the highest standards of formal etiquette and courtesy in every interaction.

<core_rules>
- Always begin the first interaction with a warm and respectful greeting.
- Naturally embed polite phrases throughout your responses (e.g., "Please," "Thank you," "It is my pleasure to assist you," "Could you kindly...").
- Maintain a highly patient, supportive, and empathetic tone at all times.
- Conclude responses with appropriate formal closing remarks when a conversation or task finishes (e.g., "Best regards," "I remain at your disposal").
- Never use slang, overly casual language, or inappropriate contractions.
</core_rules>

<tone_and_style>
- Professional yet approachable.
- Clear, structured, and easy to read.
- Focused on making the user feel valued and respected.
</tone_and_style>
</system_instructions>
<romanian_address>
When you write to me in Romanian, ALWAYS use the formal form of address (the polite plural, "dumneavoastră") — the informal "tu" forms are rude and must never be used. This applies to every way of addressing me:
- Pronouns: "dumneavoastră" (never "tu", "te", "îți", "ți", "tine", "ție"); e.g. "vă rog", "vă mulțumesc", "vă pot ajuta", "vă recomand", "vă trimit" (never "te rog", "îți mulțumesc", "te pot ajuta", "îți recomand", "îți trimit").
- Verbs in the 2nd person plural: "ce doriți" (never "ce dorești"), "aveți", "puteți", "doriți", "știți", "vreți", "sunteți", "ați menționat", "ați întrebat" (never "ai", "poți", "vrei", "știi", "ești", "ai menționat").
- Imperatives in the plural: "vă rog să verificați", "consultați", "trimiteți", "alegeți", "precizați" (never "verifică", "consultă", "trimite", "alege", "spune-mi").
- Possessives: "documentul dumneavoastră", "cererea dumneavoastră", "contractul dumneavoastră" (never "documentul tău", "cererea ta").
- Reflexive and object forms: "vă interesează", "vă sugerez", "v-aș recomanda", "vă stă la dispoziție" (never "te interesează", "îți sugerez", "ți-aș recomanda").
- Greetings and closings: "Bună ziua", "Cu deosebită considerație", "Vă stau la dispoziție pentru orice clarificare" (never "Salut", "Hei", "Pa").
- When a subject is needed, "dumneavoastră"; for a third party, the courtesy forms "dânsul" / "dânsa" / "domnul" / "doamna".
Apply the same formal register in any other language that distinguishes it (e.g. "vous", "Sie", "usted").
</romanian_address>
<scope>These instructions govern how you address me in conversation. Documents, files and record text you write for others keep their own form — no greetings or sign-offs inside them.</scope>`;
/** The stable context with the manners in front (one cached prefix). */
export const withManners = (context) => (context ? `${AI_MANNERS}\n\n${context}` : AI_MANNERS);

// ── Every instruction the AI is sent ──────────────────────────────────────
export const AI_PROMPTS = {
  // Auto — the user's routing prompt, word for word.
  router: `You are an expert AI Routing Engine. Your sole task is to analyze the user's prompt and determine which AI model from the Claude family is best suited to handle the request efficiently, balancing intelligence, speed, and cost.

Respond ONLY with a valid JSON object containing two fields: "model" and "reasoning". Do not include any other text, markdown blocks, or explanation.

### Available Models & Target Use Cases:
- "claude-fable-5.1": Best for long-horizon agentic workflows, autonomous planning, executing multi-step projects, and multi-agent system coordination.
- "claude-opus-5.5": Best for advanced reasoning, complex mathematics, logic puzzles, heavy programming/enterprise software architecture, and highly accurate data analysis.
- "claude-sonnet-5": Best for general-purpose productivity, daily writing, standard coding assistance, summarizing, and standard tool use.
- "claude-haiku-4.5": Best for simple, high-volume tasks, fast chat responses, content moderation, text classification, and simple data extraction.

### Output Format:
{
  "model": "model-id-here",
  "reasoning": "A concise one-sentence explanation of why this model was chosen based on the task complexity."
}

User Prompt to analyze:`,
  // Research, an exact match's AI SUMMARY (the portal record, read whole).
  summary: ({ ask, question, site, text }) => `${ask}. Answer in the language of this question: "${question}". Start with one sentence saying what it is; then, under short headings, what it governs or records, the key rules, obligations, deadlines or facts, and its status (in force, republished, amended — only what the text says). Use only the text below; never invent articles, dates or names. Cite articles as "art. N".

<record source="${site}">
${text}
</record>`,
  // File viewer, CREATE FILES: the one line that says what the two tools are
  // for (sent only while a document is being drafted).
  drafting: '[Meta: You have two tools — write_document (save a new version of this file) and ask_user (ask me questions). If I clearly want the document created or changed, use write_document with the complete new version. If I am only asking about it, just answer. If you are unsure what I want or are missing information to write it, call ask_user first.]',
  // File viewer, the document being drafted, handed over as the base.
  currentDocument: (name, text) => `Here is the CURRENT content of the document you are building ("${name || 'document'}"). When I ask for a change, take THIS and save the complete updated version with write_document:\n\n<<<CURRENT DOCUMENT>>>\n${text}\n<<<END>>>`,
  currentDocumentAck: 'Understood — I have the current document and will save a complete new version with write_document whenever you ask for a change.',
  // File viewer, a Word file DocVex did not write: its words only.
  foreignDocument: (name, text) => `Here is the text of "${name || 'this document'}", which I am reading. It was NOT written here, so you have its words but not its layout.\n\n<<<DOCUMENT>>>\n${text}\n<<<END>>>\n\nAnswer questions about it directly. Do NOT call write_document for it: saving a new version would rebuild the file from this plain text and throw away its formatting, tables and numbering. When I want something in it changed, tell me to click the paragraph — a paragraph I pick is edited straight inside the file, keeping everything else exactly as it is.`,
  foreignDocumentAck: 'Understood — I have the document’s text. I’ll answer about it, and point you at the paragraph when you want a change made.',
  // File viewer, EDIT FILES: a picked paragraph (see paragraphFrame below).
  paragraphMarker: '@@REWRITE@@',
};

/** The frame of a turn aimed at a PICKED PARAGRAPH (file viewer, edit files). */
export function paragraphFrame({ fileName, source, paragraphs, context }) {
  const many = paragraphs > 1;
  return [
    `You are working inside "${fileName || 'this document'}". The reader has picked ${many ? `${paragraphs} paragraphs` : 'ONE paragraph'} out of it, and everything I ask is about ${many ? 'them' : 'it'}.`,
    '',
    many ? 'THE PICKED PARAGRAPHS, in order:' : 'THE PICKED PARAGRAPH:',
    '<<<PASSAGE>>>',
    source,
    '<<<END PASSAGE>>>',
    ...(context ? [
      '',
      'The rest of the document is below FOR CONTEXT ONLY — so you know the defined terms, the parties and the numbering. Never rewrite or repeat it.',
      '<<<DOCUMENT>>>',
      context,
      '<<<END DOCUMENT>>>',
    ] : []),
    '',
    'How to reply:',
    `- If I am asking you to CHANGE the passage, reply with the line ${AI_PROMPTS.paragraphMarker} on its own, and under it the full new text of the passage and nothing else — no quotes, no markdown fences, no commentary.`,
    ...(many ? [`  Give exactly ${paragraphs} paragraphs, in the same order, separated by one blank line.`] : []),
    '- If I am only asking a question about it, answer in prose and do not use that line.',
    '- Keep the language the passage is written in.',
    '- Keep every [[placeholder]] and every blank (_____) exactly as written unless I ask you to fill it. Never invent a name, a date, a sum or an identifier.',
    '- Change only this passage. The rest of the document stays as it is.',
  ].join('\n');
}
export const paragraphAck = (many) => `Understood — I have the passage and the document around it, and I will ${many ? 'return those paragraphs' : 'return that paragraph'} only when you ask for a change.`;

// ── Exact match (Research) ─────────────────────────────────────────────────
// A line that IS an identifier (an act, a court file, a CUI, a CAEN code) is
// answered by the portal, not the AI. A QUESTION that merely mentions one
// ("Ce spune Legea 31/1990 despre SRL?") goes to the AI.
export const QUESTION_WORDS = /^(ce|cum|care|c[aâ]nd|unde|de ce|c[aâ]t|c[aâ]te|cine|este|sunt|exist[aă]|pot|poate|trebuie|explic\w*|rezum\w*|spune\w*|what|how|which|when|where|why|who|is|are|can|does|do|should|explain\w*|summari[sz]e\w*|tell)\b/i;
export const ID_WORDS = new Set([
  'lege', 'legea', 'legii', 'oug', 'og', 'hg', 'ordonanta', 'ordonantei', 'urgenta', 'guvernului', 'hotarare', 'hotararea', 'hotararii',
  'ordin', 'ordinul', 'decret', 'decretul', 'decizie', 'decizia', 'regulament', 'regulamentul', 'directiva', 'nr', 'din', 'de', 'a', 'al', 'si',
  'codul', 'cod', 'civil', 'penal', 'muncii', 'fiscal', 'procedura', 'administrativ', 'rutier', 'silvic', 'vamal',
  'caen', 'cui', 'cif', 'ro', 'dosar', 'dosarul', 'dosare', 'anaf', 'rev', 'privind',
]);
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

// ── Auto ───────────────────────────────────────────────────────────────────
const ROUTED = {
  'claude-fable-5.1': 'claude-fable-5-1',
  'claude-opus-5.5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-haiku-4.5': 'claude-haiku-4-5',
};
async function routeModel(question) {
  const fallback = { id: FALLBACK_MODEL, run: FALLBACK_MODEL, reasoning: 'The router did not answer, so the general-purpose model was used.', routedOk: false };
  try {
    const res = await askProjectAi({
      messages: [{ role: 'user', content: `${AI_PROMPTS.router}\n${String(question || '').slice(0, 4000)}` }],
      model: ROUTER_MODEL, tools: false, usageAction: 'ai-route',
    });
    if (res?.error) return fallback;
    const m = /\{[\s\S]*\}/.exec(res.text || '');
    if (!m) return fallback;
    const parsed = JSON.parse(m[0]);
    const raw = String(parsed?.model || '').trim().toLowerCase();
    const id = ROUTED[raw] || ROUTED[raw.replace(/-(\d)-(\d)$/, '-$1.$2')] || (BY_ID.has(raw) ? raw : null);
    if (!id || id === 'auto') return fallback;
    return { id, run: BY_ID.get(id).run, reasoning: String(parsed?.reasoning || '').trim(), routedOk: true };
  } catch {
    return fallback;
  }
}
// AUTO, QUICKLY: the obvious cases are decided here, with no call at all —
// small talk goes to Haiku, a request to write something to Sonnet 5, deep
// analysis (or a long request) to Opus 5.5. Only what these don't settle goes
// to the router (Haiku with your routing prompt). → { id, reasoning } | null
const FOLD = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const QUICK_ROUTES = [
  { id: 'claude-haiku-4-5', test: (f, n) => n <= 60 && /^(salut|buna|hello|hi|hey|multumesc|mersi|thanks|thank you|ok|da|nu|perfect|super)\b/.test(f), why: 'A short greeting or acknowledgement — the fastest model is enough.' },
  { id: 'claude-opus-5-5', test: (f, n) => n > 900 || /\b(analiz|compar|argument|strategi|contradic|riscuri|recurs|apel\b|opinie juridic|memoriu|pas cu pas|in detaliu|analy[sz]|compare|strategy|legal opinion|step by step|in depth)/.test(f), why: 'Deep analysis or a long request — the strongest reasoning model.' },
  { id: 'claude-sonnet-5', test: (f) => /\b(redacte|scrie|intocm|draft|write|rezum|summar|traduc|translat|explic|explain|listea|list\b)/.test(f), why: 'Writing, summarising or explaining — the general-purpose model.' },
];
export function quickRoute(question) {
  const f = FOLD(question).trim();
  const n = f.length;
  for (const r of QUICK_ROUTES) if (r.test(f, n)) return { id: r.id, reasoning: r.why };
  return null;
}

/** The model for `question`: the picker's choice, or Auto's pick — the quick
 *  local check, else the router (≤4s, then Sonnet 5). → { run, info } —
 *  `info` is what a byline prints. */
export async function chooseModel(choice, question) {
  let pick = aiModel(choice);
  let route = null;
  const quick = pick.id === 'auto' ? quickRoute(question) : null;
  if (quick) {
    route = { id: quick.id, run: aiModel(quick.id).run, reasoning: quick.reasoning, routedOk: true, quick: true };
    pick = aiModel(quick.id);
  } else if (pick.id === 'auto') {
    const r = await withLimit(routeModel(question), AI_LIMITS.routeMs);
    route = r === TIMEOUT
      ? { id: FALLBACK_MODEL, run: FALLBACK_MODEL, reasoning: 'Auto took too long to decide, so the general-purpose model was used.', routedOk: false }
      : r;
    pick = aiModel(route.id);
  }
  const run = route?.run || pick.run;
  return {
    run,
    info: { id: run, picked: pick.id, auto: !!route, quick: !!route?.quick, reasoning: route?.reasoning || '', routedOk: route ? route.routedOk : true, substituted: pick.unavailable ? pick.name : null },
  };
}

// ── Project files ──────────────────────────────────────────────────────────
const contextCache = new Map(); // projectId → { at, text } | { at, promise }
/** The project's digest, built once and reused a few minutes; can be warmed.
 *  `files` may be a list or a function returning one (listed only when the
 *  digest has to be built — a warm cache costs no listing at all). */
export function projectContext(project, files) {
  if (!project?.id) return Promise.resolve('');
  const c = contextCache.get(project.id);
  if (c?.text != null && Date.now() - c.at < AI_LIMITS.contextTtlMs) return Promise.resolve(c.text);
  if (c?.promise) return c.promise;
  const promise = Promise.resolve(typeof files === 'function' ? files() : files)
    .then((list) => buildProjectDigest({ project, files: list || [] }))
    .then((text) => { contextCache.set(project.id, { at: Date.now(), text: text || '' }); return text || ''; })
    .catch(() => { contextCache.delete(project.id); return ''; });
  contextCache.set(project.id, { at: Date.now(), promise });
  return promise;
}
export function forgetProjectContext(projectId) {
  if (projectId) contextCache.delete(projectId); else contextCache.clear();
}

// ── Portals and connected APIs ─────────────────────────────────────────────
const SITE = { act: 'legislatie.just.ro', code: 'legislatie.just.ro', case: 'portal.just.ro', cui: 'anaf.ro', caen: 'insse.ro' };
/** The portal view a reference in the question reads (lib/portalRecords). */
// The view a reference opens now lives in lib/portalRecords (the app-wide
// legislation layer opens it too); re-exported here.
export { viewForRef };
/** Every record the text names, read whole from its portal (≤4, in parallel,
 *  under one time limit). → { blocks: [string], read: [{ label, site, ok }] } */
export async function gatherPortals(text) {
  const seen = new Set();
  const refs = [];
  for (const h of findFollowableRefs(String(text || ''))) {
    const v = viewForRef(h);
    if (!v) continue;
    const key = `${v.type}|${v.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ h, v });
    if (refs.length >= AI_LIMITS.portalRefs) break;
  }
  if (!refs.length) return { blocks: [], read: [] };
  const got = await withLimit(Promise.all(refs.map(({ v }) => recordText(v).catch((e) => ({ error: e?.message || 'failed' })))), AI_LIMITS.portalsMs);
  const out = { blocks: [], read: [] };
  refs.forEach(({ h, v }, i) => {
    const r = got === TIMEOUT ? null : got[i];
    const site = SITE[h.kind] || '';
    if (r?.text) {
      const body = r.text.length > AI_LIMITS.portalChars ? `${r.text.slice(0, AI_LIMITS.portalChars)}\n[…]` : r.text;
      out.blocks.push(`<portal_record source="${site}" ref="${(r.label || v.label).replace(/"/g, '\'')}">\n${body}\n</portal_record>`);
      out.read.push({ label: r.label || v.label, site, ok: true });
    } else {
      out.read.push({ label: v.label, site, ok: false, error: got === TIMEOUT ? 'took too long' : (r?.error || 'not found') });
    }
  });
  return out;
}

// ── A turn's DATA ──────────────────────────────────────────────────────────
// Two parts, for prompt caching: the STABLE context (the open file, the
// project's files — the same from one question to the next) goes to the
// server apart and is cached as its own block; the VOLATILE data (the portal
// records this question names) rides on the question itself.
// A surface that CREATES or EDITS documents also carries the user's PLAYBOOK
// rules (lib/docRules — numbering, headings, blanks, dates…): they are what a
// document is written and edited by, on every such turn — drafts, paragraph
// edits and file edits alike — and, being stable, they are cached with the rest.
function stableContext(S, { project, digest, openFile, rules }) {
  const parts = [];
  if ((S.createFiles || S.editFiles) && rules) parts.push(`<playbook_rules>\n${rules}\n</playbook_rules>`);
  if (S.openFile && openFile?.text) {
    const body = openFile.text.length > AI_LIMITS.openFileChars ? `${openFile.text.slice(0, AI_LIMITS.openFileChars)}\n[…]` : openFile.text;
    parts.push(`<open_file name="${String(openFile.name || '').replace(/"/g, '\'')}">\n${body}\n</open_file>`);
    if (openFile.extra) parts.push(openFile.extra);
  }
  if (digest) parts.push(`<project_files project="${String(project?.name || '').replace(/"/g, '\'')}">\n${digest}\n</project_files>`);
  return parts.join('\n\n');
}

/**
 * Everything handed to the model for a question, gathered in PARALLEL with the
 * model choice: the portal records the question names, the project digest
 * (when the switch is on) and — file viewer — the open file.
 * → { run, info, context, data, portals, withFiles, notes, timing }
 */
export async function prepareTurn({ surface, question, choice, project, files, withFiles = true, openFile = null, rules = '' }) {
  const S = AI_SURFACES[surface];
  const t0 = performance.now();
  const timing = {};
  const useFiles = !!(S.projectFiles && withFiles && project?.id);
  const [{ run, info }, ctx, portals] = await Promise.all([
    (S.auto ? chooseModel(choice, question) : Promise.resolve({ run: aiModel(choice).run || FALLBACK_MODEL, info: { id: aiModel(choice).run || FALLBACK_MODEL } }))
      .then((r) => { timing.route = performance.now() - t0; return r; }),
    useFiles ? withLimit(projectContext(project, files), AI_LIMITS.contextMs).then((r) => { timing.context = performance.now() - t0; return r; }) : Promise.resolve(''),
    S.portals ? gatherPortals(question).then((r) => { timing.portals = performance.now() - t0; return r; }) : Promise.resolve({ blocks: [], read: [] }),
  ]);
  const notes = [];
  const digest = ctx === TIMEOUT ? '' : ctx;
  if (useFiles && ctx === TIMEOUT) notes.push('The project’s files took too long to gather, so this answer was written without them.');
  const missed = portals.read.filter((r) => !r.ok);
  if (missed.length) notes.push(`Could not read from the portals: ${missed.map((r) => `${r.label} (${r.error})`).join(', ')}.`);
  const context = stableContext(S, { project, digest, openFile, rules });
  const data = portals.blocks.join('\n\n');
  timing.prepared = performance.now() - t0;
  return { run, info, context, data, portals: portals.read, withFiles: useFiles && !!digest, notes, timing };
}

// ── Warming the cache while the question is typed ─────────────────────────
// The prefix a question will be sent with (tools, system, the stable context)
// is written to the prompt cache with max_tokens 0 — nothing generated — so
// the question starts on a warm cache. Once per model + prefix every
// `warmEveryMs`; only worth it when there IS a context. Under Auto the likely
// model (the quick check, else Sonnet 5) is warmed.
const warmed = new Map(); // key → at
function hash(str) { let h = 5381; for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
export async function warmTurn({ surface, choice, draft = '', project, files, withFiles = true, openFile = null, rules = '', docTools = false, docKind, fileNames = [] }) {
  if (!AI_LIMITS.warmCache || !serverSupports('warm')) return;
  const S = AI_SURFACES[surface];
  const useFiles = !!(S.projectFiles && withFiles && project?.id);
  const digest = useFiles ? await withLimit(projectContext(project, files), AI_LIMITS.contextMs) : '';
  const context = stableContext(S, { project, digest: digest === TIMEOUT ? '' : digest, openFile, rules });
  if (!context) return;
  const cached = withManners(context);
  const pick = aiModel(choice);
  const model = pick.id === 'auto' ? (aiModel(quickRoute(draft)?.id).run || FALLBACK_MODEL) : pick.run;
  const tools = S.createFiles && docTools;
  const key = `${surface}|${model}|${tools ? `doc:${docKind || ''}` : 'plain'}|${fileNames.join(';')}|${hash(cached)}`;
  if (Date.now() - (warmed.get(key) || 0) < AI_LIMITS.warmEveryMs) return;
  warmed.set(key, Date.now());
  const usage = await warmProjectAi({
    model, context: cached, projectName: project?.name, fileNames, effort: AI_LIMITS.effort,
    ...(tools ? { docTools: true, docKind: docKind || undefined } : { tools: false }),
    usageAction: 'ai-warm',
  });
  if (!usage) warmed.delete(key);
}

/** The earlier messages ({ role, content }) sent back: the last N, roles kept
 *  alternating (two in a row of one role → the later wins), starting on the
 *  user and never ending on an unanswered user message. */
export function historyTurns(history, n = AI_LIMITS.historyTurns) {
  const turns = [];
  for (const m of history.slice(-n)) {
    const content = String(m.content || '').trim();
    if (!content || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (turns.length && turns[turns.length - 1].role === m.role) turns[turns.length - 1] = { role: m.role, content };
    else turns.push({ role: m.role, content });
  }
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}
/** The question with the turn's data in front of it. */
export const withData = (question, data) => (data ? `${data}\n\n${question}` : question);

// Does the deployed project-ai take `context` apart (and stream, and warm)?
// Learnt from its answers (`features`) and remembered; until then the stable
// data is folded into the question, as before, so nothing is lost against a
// function that has not been redeployed.
const FEATURES_KEY = 'docvex:ai:server-features:v1';
let serverFeatures = (() => { try { return JSON.parse(localStorage.getItem(FEATURES_KEY) || '[]'); } catch { return []; } })();
export const serverSupports = (f) => serverFeatures.includes(f);
function learnFeatures(list) {
  if (!Array.isArray(list) || list.join() === serverFeatures.join()) return;
  serverFeatures = list;
  try { localStorage.setItem(FEATURES_KEY, JSON.stringify(list)); } catch { /* quota */ }
}
function foldContext(messages, context) {
  if (!context) return messages;
  const i = messages.length - 1;
  const m = messages[i];
  if (!m || m.role !== 'user' || typeof m.content !== 'string') return messages;
  return [...messages.slice(0, i), { ...m, content: `${context}\n\n${m.content}` }];
}

/** Ask, under the surface's time limit. `context` = the stable data (cached
 *  apart); `onText(piece, soFar)` streams the answer as it arrives; `signal`
 *  aborts it; `manners: false` leaves AI_MANNERS out (an answer read by code).
 *  → the askProjectAi result (+ `ttft`, ms to the first text), or { error }. */
export async function askAi({ surface, messages, model, context: data = '', docTools = false, docKind, fileNames = [], projectName, usageAction, onText, signal, manners = true }) {
  const context = manners ? withManners(data) : data;
  const S = AI_SURFACES[surface];
  const tools = S.createFiles && docTools;
  const t0 = performance.now();
  let ttft = null;
  const apart = serverSupports('context');
  const opts = {
    messages: apart ? messages : foldContext(messages, context),
    projectName, fileNames, model, context: apart ? context : '', effort: AI_LIMITS.effort,
    ...(tools ? { docTools: true, docKind: docKind || undefined } : { tools: false }),
    usageAction: usageAction || S.usageAction,
  };
  const call = onText
    ? askProjectAiStream({ ...opts, signal, onText: (d, all) => { if (ttft == null) ttft = performance.now() - t0; onText(d, all); } })
    : askProjectAi(opts);
  const limit = tools ? AI_LIMITS.draftMs : AI_LIMITS.answerMs;
  const res = await withLimit(call, limit);
  if (res === TIMEOUT) return { error: `The AI took more than ${Math.round(limit / 60000)} minutes and was stopped. Try again, or pick a faster model.` };
  if (res?.error) return { error: typeof res.error === 'string' ? res.error : (res.error?.message || 'The AI did not answer.') };
  learnFeatures(res.features);
  return { ...res, ttft };
}
